import { describe, expect, it } from "vitest";
import { JiraCloudAssigneeResolutionAdapter } from "../../src/adapters/jira-cloud/jira-assignee-resolution.adapter.js";
import { JiraCloudWriteAdapter } from "../../src/adapters/jira-cloud/jira-write.adapter.js";
import { JamError } from "../../src/domain/errors.js";
import { FakeCredentials } from "../helpers.js";

/**
 * The REST boundary for assignment.
 *
 * Two things are pinned here and nowhere else: the exact requests Jira expects,
 * and the fact that a user Jira described in a way JAM cannot use is dropped
 * rather than half-understood.
 */

type Call = { url: string; method: string; body: unknown };

function recorder(respond: (call: Call, n: number) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return respond(calls[calls.length - 1]!, calls.length);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("JiraCloudAssigneeResolutionAdapter.searchUsers", () => {
  it("asks the user search endpoint, and maps identity, name and activity", async () => {
    const { calls, fetchImpl } = recorder(() =>
      json([
        { accountId: "acc-1", displayName: "Min Kim", active: true, accountType: "atlassian" },
        { accountId: "acc-2", displayName: "Gone", active: false, accountType: "atlassian" },
      ]),
    );
    const adapter = new JiraCloudAssigneeResolutionAdapter(new FakeCredentials(), fetchImpl);

    const users = await adapter.searchUsers("Min Kim");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/rest/api/3/user/search");
    expect(calls[0]!.url).toContain("query=Min+Kim");
    expect(users).toEqual([
      { accountId: "acc-1", displayName: "Min Kim", active: true },
      { accountId: "acc-2", displayName: "Gone", active: false },
    ]);
  });

  it("encodes a query that is not ASCII", async () => {
    const { calls, fetchImpl } = recorder(() => json([]));
    const adapter = new JiraCloudAssigneeResolutionAdapter(new FakeCredentials(), fetchImpl);

    // A stand-in name, not anyone's. What is under test is the encoding of a
    // non-ASCII query, which any Hangul string exercises equally.
    await adapter.searchUsers("홍길동");

    expect(calls[0]!.url).toContain(encodeURIComponent("홍길동"));
  });

  it("works when Jira hides the email, which it usually does", async () => {
    // Privacy settings blank `emailAddress` for most users on a real site, so
    // an identity that depended on it would work for some colleagues and
    // silently fail for others on the same instance.
    const { fetchImpl } = recorder(() =>
      json([{ accountId: "acc-1", displayName: "Min Kim", active: true, emailAddress: "" }]),
    );
    const adapter = new JiraCloudAssigneeResolutionAdapter(new FakeCredentials(), fetchImpl);

    expect(await adapter.searchUsers("Min")).toEqual([
      { accountId: "acc-1", displayName: "Min Kim", active: true },
    ]);
  });

  it("drops a user with no accountId, because there is no identity to assign", async () => {
    const { fetchImpl } = recorder(() =>
      json([{ displayName: "No Account" }, { accountId: "acc-1", displayName: "Min Kim" }]),
    );
    const adapter = new JiraCloudAssigneeResolutionAdapter(new FakeCredentials(), fetchImpl);

    expect(await adapter.searchUsers("x")).toEqual([
      { accountId: "acc-1", displayName: "Min Kim", active: true },
    ]);
  });

  it("drops app and customer accounts, which are not the colleague anyone meant", async () => {
    const { fetchImpl } = recorder(() =>
      json([
        { accountId: "acc-app", displayName: "Automation for Jira", accountType: "app" },
        { accountId: "acc-cust", displayName: "A Customer", accountType: "customer" },
        { accountId: "acc-1", displayName: "Min Kim", accountType: "atlassian" },
      ]),
    );
    const adapter = new JiraCloudAssigneeResolutionAdapter(new FakeCredentials(), fetchImpl);

    expect((await adapter.searchUsers("a")).map((u) => u.accountId)).toEqual(["acc-1"]);
  });

  it("treats an answer that is not a list as no users, not as a failure", async () => {
    const { fetchImpl } = recorder(() => json({ values: [] }));
    const adapter = new JiraCloudAssigneeResolutionAdapter(new FakeCredentials(), fetchImpl);

    expect(await adapter.searchUsers("x")).toEqual([]);
  });
});

describe("JiraCloudAssigneeResolutionAdapter.isAssignable", () => {
  it("asks about this issue and this account, and nothing fuzzier", async () => {
    const { calls, fetchImpl } = recorder(() =>
      json([{ accountId: "acc-1", displayName: "Min Kim", active: true }]),
    );
    const adapter = new JiraCloudAssigneeResolutionAdapter(new FakeCredentials(), fetchImpl);

    expect(await adapter.isAssignable("PROJECT-1", "acc-1")).toBe(true);
    expect(calls[0]!.url).toContain("/rest/api/3/user/assignable/search");
    expect(calls[0]!.url).toContain("issueKey=PROJECT-1");
    expect(calls[0]!.url).toContain("accountId=acc-1");
  });

  it("is false when Jira offers nobody", async () => {
    const { fetchImpl } = recorder(() => json([]));
    const adapter = new JiraCloudAssigneeResolutionAdapter(new FakeCredentials(), fetchImpl);

    expect(await adapter.isAssignable("PROJECT-1", "acc-1")).toBe(false);
  });

  it("is false when Jira answers about somebody else", async () => {
    // An answer about a different account is not an answer to the question
    // that was asked, however encouraging its shape.
    const { fetchImpl } = recorder(() =>
      json([{ accountId: "acc-other", displayName: "Someone Else", active: true }]),
    );
    const adapter = new JiraCloudAssigneeResolutionAdapter(new FakeCredentials(), fetchImpl);

    expect(await adapter.isAssignable("PROJECT-1", "acc-1")).toBe(false);
  });

  it("does not retry, because its answer decides a mutation", async () => {
    const { calls, fetchImpl } = recorder(() => json({ message: "unavailable" }, 503));
    const adapter = new JiraCloudAssigneeResolutionAdapter(new FakeCredentials(), fetchImpl);

    await expect(adapter.isAssignable("PROJECT-1", "acc-1")).rejects.toBeInstanceOf(JamError);

    expect(calls).toHaveLength(1);
  });
});

describe("JiraCloudWriteAdapter.assignIssue", () => {
  it("PUTs the accountId to the assignee endpoint, and nothing else", async () => {
    const { calls, fetchImpl } = recorder(() => new Response(null, { status: 204 }));
    const adapter = new JiraCloudWriteAdapter(new FakeCredentials(), fetchImpl);

    await adapter.assignIssue("PROJECT-1", "acc-1");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://example.atlassian.net/rest/api/3/issue/PROJECT-1/assignee");
    // The name never travels. Jira Cloud identifies users by account, and a
    // display name is a label two people can share.
    expect(calls[0]!.body).toEqual({ accountId: "acc-1" });
  });

  it("encodes a key that needs it", async () => {
    const { calls, fetchImpl } = recorder(() => new Response(null, { status: 204 }));
    const adapter = new JiraCloudWriteAdapter(new FakeCredentials(), fetchImpl);

    await adapter.assignIssue("PROJECT 1/2", "acc-1");

    expect(calls[0]!.url).toContain("PROJECT%201%2F2/assignee");
  });

  it("does not retry a 503", async () => {
    const { calls, fetchImpl } = recorder(() => json({ message: "unavailable" }, 503));
    const adapter = new JiraCloudWriteAdapter(new FakeCredentials(), fetchImpl);

    await expect(adapter.assignIssue("PROJECT-1", "acc-1")).rejects.toBeInstanceOf(JamError);

    expect(calls).toHaveLength(1);
  });

  it("does not retry a dropped connection", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const adapter = new JiraCloudWriteAdapter(new FakeCredentials(), fetchImpl);

    await expect(adapter.assignIssue("PROJECT-1", "acc-1")).rejects.toBeTruthy();

    expect(attempts).toBe(1);
  });
});

describe("JiraCloudAssigneeResolutionAdapter.getUserByAccountId", () => {
  it("asks the exact user endpoint, not the search", async () => {
    const { calls, fetchImpl } = recorder(() =>
      json({ accountId: "acc-1", displayName: "Min Kim", active: true }),
    );
    const adapter = new JiraCloudAssigneeResolutionAdapter(new FakeCredentials(), fetchImpl);

    const user = await adapter.getUserByAccountId("acc-1");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/rest/api/3/user?");
    expect(calls[0]!.url).toContain("accountId=acc-1");
    expect(calls[0]!.url).not.toContain("/user/search");
    expect(user).toEqual({ accountId: "acc-1", displayName: "Min Kim", active: true });
  });

  it("encodes an accountId containing a colon", async () => {
    // Real Jira Cloud ids look like `712020:d876...`, and an unencoded colon
    // in a query string is not the id Jira was asked about.
    const { calls, fetchImpl } = recorder(() => json({ accountId: "712020:abc", displayName: "X" }));
    const adapter = new JiraCloudAssigneeResolutionAdapter(new FakeCredentials(), fetchImpl);

    await adapter.getUserByAccountId("712020:abc");

    expect(calls[0]!.url).toContain("accountId=712020%3Aabc");
  });

  it("reports an account Jira will not show as absent, not as a failure", async () => {
    // 404 covers both "no such account" and "this token cannot see it", and
    // they are the same answer to somebody who wanted to assign it.
    const { fetchImpl } = recorder(() => json({ errorMessages: ["does not exist"] }, 404));
    const adapter = new JiraCloudAssigneeResolutionAdapter(new FakeCredentials(), fetchImpl);

    expect(await adapter.getUserByAccountId("acc-nobody")).toBeUndefined();
  });

  it("does not turn a real failure into an absence", async () => {
    const { fetchImpl } = recorder(() => json({ message: "unavailable" }, 503));
    const adapter = new JiraCloudAssigneeResolutionAdapter(new FakeCredentials(), fetchImpl);

    await expect(adapter.getUserByAccountId("acc-1")).rejects.toBeInstanceOf(JamError);
  });

  it("drops an app account here too", async () => {
    const { fetchImpl } = recorder(() =>
      json({ accountId: "acc-app", displayName: "Automation", accountType: "app" }),
    );
    const adapter = new JiraCloudAssigneeResolutionAdapter(new FakeCredentials(), fetchImpl);

    expect(await adapter.getUserByAccountId("acc-app")).toBeUndefined();
  });

  it("does not retry, because its answer decides a mutation", async () => {
    const { calls, fetchImpl } = recorder(() => json({ message: "unavailable" }, 503));
    const adapter = new JiraCloudAssigneeResolutionAdapter(new FakeCredentials(), fetchImpl);

    await expect(adapter.getUserByAccountId("acc-1")).rejects.toBeInstanceOf(JamError);

    expect(calls).toHaveLength(1);
  });
});

describe("JiraCloudAssigneeResolutionAdapter.searchUsers with an accountId", () => {
  it("passes the accountId through as the query, which Jira currently matches", async () => {
    // Pinned because JAM relies on it for the common path: the exact lookup is
    // the fallback, and this is the request that usually makes it unnecessary.
    const { calls, fetchImpl } = recorder(() =>
      json([{ accountId: "712020:abc", displayName: "Min Kim", active: true }]),
    );
    const adapter = new JiraCloudAssigneeResolutionAdapter(new FakeCredentials(), fetchImpl);

    const users = await adapter.searchUsers("712020:abc");

    expect(calls[0]!.url).toContain("/rest/api/3/user/search");
    expect(calls[0]!.url).toContain("query=712020%3Aabc");
    expect(users).toEqual([{ accountId: "712020:abc", displayName: "Min Kim", active: true }]);
  });
});
