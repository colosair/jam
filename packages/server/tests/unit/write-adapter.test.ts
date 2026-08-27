import { describe, expect, it } from "vitest";
import { JiraCloudWriteAdapter } from "../../src/adapters/jira-cloud/jira-write.adapter.js";
import { textToAdf } from "../../src/domain/adf.js";
import { JamError } from "../../src/domain/errors.js";
import type { CredentialPort } from "../../src/ports/credentials.port.js";

/**
 * The REST boundary.
 *
 * Two things are worth pinning here and nowhere else: the exact request shapes
 * Jira expects, and the fact that this adapter never sends a request twice.
 */

const credentials: CredentialPort = {
  load: () => ({
    baseUrl: "https://example.atlassian.net",
    email: "nobody@example.com",
    apiToken: "placeholder",
  }),
  describe: () => ({ hasToken: true, source: "process" }),
};

type Call = { url: string; method: string; body: unknown };

function recorder(respond: (call: Call, n: number) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return respond(call, calls.length);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Jira answers a successful update or transition with 204 and no body. */
function noContent(): Response {
  return new Response(null, { status: 204 });
}

describe("what the adapter sends", () => {
  it("updates fields with a PUT carrying only those fields", async () => {
    const { calls, fetchImpl } = recorder(() => noContent());
    await new JiraCloudWriteAdapter(credentials, fetchImpl).updateIssue("PROJECT-1", {
      summary: "New",
    });

    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toContain("/rest/api/3/issue/PROJECT-1");
    expect(calls[0]?.body).toEqual({ fields: { summary: "New" } });
  });

  it("posts a comment as ADF built here, never as caller-supplied structure", async () => {
    const { calls, fetchImpl } = recorder(() => json({ id: "10101" }));
    const result = await new JiraCloudWriteAdapter(credentials, fetchImpl).addComment(
      "PROJECT-1",
      "Line one.\n\nLine two.",
    );

    expect(result).toEqual({ id: "10101" });
    expect(calls[0]?.url).toContain("/rest/api/3/issue/PROJECT-1/comment");
    expect(calls[0]?.body).toEqual({
      body: {
        type: "doc",
        version: 1,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Line one." }] },
          { type: "paragraph", content: [{ type: "text", text: "Line two." }] },
        ],
      },
    });
  });

  it("treats a comment Jira would not identify as unconfirmed", async () => {
    const { fetchImpl } = recorder(() => json({}));
    const adapter = new JiraCloudWriteAdapter(credentials, fetchImpl);

    await expect(adapter.addComment("PROJECT-1", "hi")).rejects.toMatchObject({
      code: "JAM_WRITE_UNCERTAIN",
    });
  });

  it("reads transitions and reports the status each one leads to", async () => {
    const { calls, fetchImpl } = recorder(() =>
      json({
        transitions: [
          { id: "31", name: "Done", to: { name: "완료" } },
          { id: "21", name: "Start Progress", to: { name: "진행 중" } },
          { name: "no id - unusable" },
        ],
      }),
    );

    const transitions = await new JiraCloudWriteAdapter(credentials, fetchImpl).getTransitions(
      "PROJECT-1",
    );

    expect(calls[0]?.method).toBe("GET");
    expect(transitions).toEqual([
      { id: "31", name: "Done", to: "완료" },
      { id: "21", name: "Start Progress", to: "진행 중" },
    ]);
  });

  it("executes a transition by id", async () => {
    const { calls, fetchImpl } = recorder(() => noContent());
    await new JiraCloudWriteAdapter(credentials, fetchImpl).transitionIssue("PROJECT-1", "31");

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/rest/api/3/issue/PROJECT-1/transitions");
    expect(calls[0]?.body).toEqual({ transition: { id: "31" } });
  });
});

describe("the adapter never sends a write twice", () => {
  it("does not retry a 503, unlike the read path", async () => {
    const { calls, fetchImpl } = recorder(() => json({ errorMessages: ["down"] }, 503));
    const adapter = new JiraCloudWriteAdapter(credentials, fetchImpl);

    await expect(adapter.addComment("PROJECT-1", "hi")).rejects.toBeInstanceOf(JamError);

    // A retry here is how one comment becomes two: Jira may have accepted the
    // first attempt and lost only the answer.
    expect(calls).toHaveLength(1);
  });

  it("does not retry a rate limit either", async () => {
    const { calls, fetchImpl } = recorder(() => json({}, 429));
    const adapter = new JiraCloudWriteAdapter(credentials, fetchImpl);

    await expect(adapter.transitionIssue("PROJECT-1", "31")).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("how failures are reported", () => {
  it.each([
    [401, "JIRA_AUTH_FAILED"],
    [403, "JIRA_PERMISSION_DENIED"],
    [404, "ISSUE_NOT_FOUND"],
  ])("maps %i onto %s", async (status, code) => {
    const { fetchImpl } = recorder(() => json({ errorMessages: ["nope"] }, status));
    const adapter = new JiraCloudWriteAdapter(credentials, fetchImpl);

    await expect(adapter.updateIssue("PROJECT-1", { summary: "x" })).rejects.toMatchObject({ code });
  });

  it("never puts the credential in the failure", async () => {
    const { fetchImpl } = recorder(() => json({ errorMessages: ["nope"] }, 403));
    const adapter = new JiraCloudWriteAdapter(credentials, fetchImpl);

    const error = await adapter.updateIssue("PROJECT-1", { summary: "x" }).catch((e: JamError) => e);
    expect(JSON.stringify(error.toPayload())).not.toContain("placeholder");
  });
});

describe("plain text to ADF", () => {
  it("keeps markdown-looking text literal", () => {
    // A comment that says `*not bold*` should say that, not become emphasis.
    expect(textToAdf("*not bold* # not a heading")).toMatchObject({
      content: [{ content: [{ text: "*not bold* # not a heading" }] }],
    });
  });

  it("splits on blank lines only", () => {
    const doc = textToAdf("a\nb\n\nc") as { content: unknown[] };
    expect(doc.content).toHaveLength(2);
  });
});

describe("JiraCloudWriteAdapter.createIssue", () => {
  it("POSTs the create to /rest/api/3/issue with the fields it was given", async () => {
    const { calls, fetchImpl } = recorder(() => json({ id: "10500", key: "PROJECT-500" }));
    const adapter = new JiraCloudWriteAdapter(credentials, fetchImpl);

    const created = await adapter.createIssue({
      project: { key: "PROJECT" },
      issuetype: { id: "10001" },
      summary: "Write the thing",
      description: textToAdf("why"),
      priority: { name: "High" },
      labels: ["jam"],
      components: [{ name: "Backend" }],
    });

    expect(created).toEqual({ id: "10500", key: "PROJECT-500" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://example.atlassian.net/rest/api/3/issue");
    expect(calls[0]!.body).toEqual({
      fields: {
        project: { key: "PROJECT" },
        issuetype: { id: "10001" },
        summary: "Write the thing",
        description: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: "why" }] }],
        },
        priority: { name: "High" },
        labels: ["jam"],
        components: [{ name: "Backend" }],
      },
    });
  });

  it("does not retry a 503 - a second create is a second issue", async () => {
    const { calls, fetchImpl } = recorder(() => json({ message: "unavailable" }, 503));
    const adapter = new JiraCloudWriteAdapter(credentials, fetchImpl);

    await expect(adapter.createIssue({ summary: "x" })).rejects.toBeInstanceOf(JamError);

    expect(calls).toHaveLength(1);
  });

  it("does not retry a 429 either", async () => {
    const { calls, fetchImpl } = recorder(() => json({ message: "slow down" }, 429));
    const adapter = new JiraCloudWriteAdapter(credentials, fetchImpl);

    await expect(adapter.createIssue({ summary: "x" })).rejects.toBeInstanceOf(JamError);

    expect(calls).toHaveLength(1);
  });

  it("does not retry a dropped connection", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const adapter = new JiraCloudWriteAdapter(credentials, fetchImpl);

    await expect(adapter.createIssue({ summary: "x" })).rejects.toBeTruthy();

    expect(attempts).toBe(1);
  });

  it("reports a create Jira would not name as uncertain, not as done", async () => {
    // An issue may now exist that JAM cannot point at. That is the uncertain
    // case exactly: say so, and do not send it again.
    const { fetchImpl } = recorder(() => json({}));
    const adapter = new JiraCloudWriteAdapter(credentials, fetchImpl);

    await expect(adapter.createIssue({ project: { key: "PROJECT" } })).rejects.toMatchObject({
      code: "JAM_WRITE_UNCERTAIN",
      details: { project: "PROJECT" },
    });
  });
});

describe("canonicalizePlainText", () => {
  it("is what textToAdf does to the text, and nothing more", async () => {
    // The two have to agree, because one decides what JAM sends and the other
    // decides what JAM will accept as proof it arrived.
    const { canonicalizePlainText } = await import("../../src/domain/adf.js");

    const raw = "  One.\n\n\n\nTwo.   \n";
    const doc = textToAdf(raw) as { content: { content: { text: string }[] }[] };

    expect(canonicalizePlainText(raw)).toBe("One.\n\nTwo.");
    expect(doc.content.map((p) => p.content[0]!.text)).toEqual(["One.", "Two."]);
  });

  it("keeps a single newline, which is a line break the author wrote", async () => {
    const { canonicalizePlainText } = await import("../../src/domain/adf.js");

    expect(canonicalizePlainText("a\nb")).toBe("a\nb");
  });
});
