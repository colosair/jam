import { describe, expect, it } from "vitest";
import { JiraClient, mapStatus } from "../../src/adapters/jira-cloud/jira-client.js";
import { JamError, toJamError } from "../../src/domain/errors.js";
import { FakeCredentials } from "../helpers.js";

const SECRET = "SUPER_SECRET_TOKEN";

describe("mapStatus", () => {
  it.each([
    [400, "JQL_INVALID"],
    [401, "JIRA_AUTH_FAILED"],
    [403, "JIRA_PERMISSION_DENIED"],
    [404, "ISSUE_NOT_FOUND"],
    [429, "RATE_LIMITED"],
    [500, "JIRA_UNAVAILABLE"],
    [503, "JIRA_UNAVAILABLE"],
  ])("maps HTTP %i to %s", (status, code) => {
    expect(mapStatus(status, "{}", "/rest/api/3/myself").code).toBe(code);
  });

  it("forwards Jira's own message without the raw payload", () => {
    const err = mapStatus(400, JSON.stringify({ errorMessages: ["Field 'nope' does not exist"] }), "/x");
    expect(err.message).toContain("Field 'nope' does not exist");
    expect(err.message).not.toContain("errorMessages");
  });

  it("survives a non-JSON error body", () => {
    expect(mapStatus(500, "<html>gateway</html>", "/x").code).toBe("JIRA_UNAVAILABLE");
  });
});

describe("toJamError", () => {
  it("passes JamError through and wraps anything else", () => {
    const original = new JamError("RATE_LIMITED", "slow down");
    expect(toJamError(original)).toBe(original);
    expect(toJamError(new Error("boom")).code).toBe("JIRA_UNAVAILABLE");
    expect(toJamError("string failure").code).toBe("JIRA_UNAVAILABLE");
  });
});

describe("credential handling", () => {
  it("sends Basic auth but never puts the token in a thrown error", async () => {
    let sentAuth: string | undefined;
    const fakeFetch: typeof fetch = async (_url, init) => {
      sentAuth = new Headers(init?.headers).get("authorization") ?? undefined;
      return new Response(JSON.stringify({ errorMessages: ["nope"] }), { status: 403 });
    };

    const client = new JiraClient(new FakeCredentials(), fakeFetch);
    const error = await client
      .request({ path: "rest/api/3/myself" })
      .then(() => undefined)
      .catch((e: unknown) => toJamError(e));

    expect(sentAuth).toBe(`Basic ${Buffer.from(`user@example.com:${SECRET}`).toString("base64")}`);
    expect(error?.code).toBe("JIRA_PERMISSION_DENIED");
    expect(JSON.stringify(error?.toPayload())).not.toContain(SECRET);
    expect(JSON.stringify(error?.toPayload())).not.toContain("Basic ");
  });

  it("does not leak the token through a network failure message", async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const client = new JiraClient(new FakeCredentials(), fakeFetch);
    const error = await client
      .request({ path: "rest/api/3/myself" })
      .then(() => undefined)
      .catch((e: unknown) => toJamError(e));

    expect(error?.code).toBe("JIRA_UNAVAILABLE");
    expect(error?.message).not.toContain(SECRET);
  });

  it("describe() reports token presence without the value", () => {
    const described = new FakeCredentials().describe();
    expect(described.hasToken).toBe(true);
    expect(JSON.stringify(described)).not.toContain(SECRET);
  });
});
