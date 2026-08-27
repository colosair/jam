import { describe, expect, it } from "vitest";
import { JiraCloudReadAdapter } from "../../src/adapters/jira-cloud/jira-read.adapter.js";
import { applyWritePlan } from "../../src/application/apply-write.js";
import { planWrite } from "../../src/application/plan-write.js";
import { WritePlanStore } from "../../src/application/write-plan-store.js";
import {
  FakeCreateMetadata,
  FakeCredentials,
  FakeJira,
  FakeJiraWrite,
  issue,
  testConfig,
  testDeps,
} from "../helpers.js";

/**
 * ConsistencyPolicy calls for a direct issue GET around a write.
 *
 * `getIssues` is a bulk endpoint that takes a list; a bulk read is free to
 * answer from a different path than the single-issue GET, and "close enough
 * for a listing" is not close enough for the read that decides whether a
 * mutation may proceed or whether one landed. So the write plane uses
 * `getIssue`, and this is where that is held to.
 */

type Call = { url: string; method: string };

function recorder(body: unknown, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("JiraCloudReadAdapter.getIssue", () => {
  it("GETs the single-issue endpoint, not bulkfetch", async () => {
    const { calls, fetchImpl } = recorder({
      key: "PROJECT-1",
      fields: { summary: "Hello", status: { name: "Open" }, updated: "2026-08-27T00:00:00.000Z" },
    });
    const adapter = new JiraCloudReadAdapter(new FakeCredentials(), testConfig(), fetchImpl);

    const { issue } = await adapter.getIssue({ key: "PROJECT-1", fields: ["summary", "status"] });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("/rest/api/3/issue/PROJECT-1");
    expect(calls[0]!.url).not.toContain("bulkfetch");
    expect(calls[0]!.url).toContain("fields=summary%2Cstatus");
    expect(issue).toMatchObject({ key: "PROJECT-1", summary: "Hello", status: "Open" });
  });

  it("reports an issue it cannot see as absent rather than as a failure", async () => {
    // The caller decides what "not there" means - ISSUE_NOT_FOUND for a write,
    // something else for a listing. The adapter does not decide it for them.
    const { fetchImpl } = recorder({});
    const adapter = new JiraCloudReadAdapter(new FakeCredentials(), testConfig(), fetchImpl);

    const result = await adapter.getIssue({ key: "PROJECT-9", fields: ["summary"] });

    expect(result.issue).toBeUndefined();
  });
});

describe("the write plane's reads", () => {
  it("confirms a create with a direct issue GET, and never with the bulk endpoint", async () => {
    const metadata = new FakeCreateMetadata();
    const write = new FakeJiraWrite();
    write.createdKey = "PROJECT-500";
    const jira = new FakeJira({
      issues: [issue({ key: "PROJECT-500", summary: "Write the thing", issueType: "Task" })],
    });

    const jam = testDeps(
      jira,
      testConfig({ project: { key: "PROJECT" } }),
      write,
      new WritePlanStore(),
      metadata,
    );

    const { receipt } = await planWrite(jam, {
      operation: "issue.create",
      input: { issueType: "Task", summary: "Write the thing" },
    });
    await applyWritePlan(jam, { planId: receipt.planId });

    // Exactly the reads a create makes: none while planning, one to confirm -
    // and that one through the single-issue endpoint.
    expect(jira.directIssueCalls.map((c) => c.key)).toEqual(["PROJECT-500"]);
    expect(jira.directIssueCalls[0]!.fields).toContain("description");
    expect(jira.issueCalls).toHaveLength(0);
    expect(jira.searchCalls).toHaveLength(0);
  });

  it("checks an existing issue for a conflict through the same endpoint", async () => {
    const write = new FakeJiraWrite();
    const jira = new FakeJira({ issues: [issue({ key: "PROJECT-1" })] });
    const jam = testDeps(jira, testConfig({ project: { key: "PROJECT" } }), write);

    const { receipt } = await planWrite(jam, {
      key: "PROJECT-1",
      operation: "field.update",
      input: { summary: "Renamed" },
    });

    expect(jira.directIssueCalls.map((c) => c.key)).toEqual(["PROJECT-1"]);
    expect(jira.issueCalls).toHaveLength(0);
    expect(receipt.status).toBe("planned");
  });
});
