// Three different situations used to collapse into two wrong codes.
//
//   a preview stopping at page one          -> reported as PARTIAL_API_RESPONSE
//   a complete walk hitting the page cap    -> reported as OUTPUT_BUDGET
//   a result larger than the token budget   -> reported correctly, in notes
//
// The first two both read as failures they are not. "Partial API response" says
// Jira answered with less than it was asked for; a preview is the caller
// getting exactly what they asked for. "Output budget" says something was
// dropped to fit a size; the page cap is about how far the read walked, and
// nothing was trimmed.
//
// The third was already right and is pinned here so it stays that way: a result
// can be complete and still be too large to want, and saying so must not turn
// `complete` false.

import { describe, expect, it } from "vitest";

import { searchIssues } from "../../src/application/search-issues.js";
import { FakeJira, issue, testConfig, testDeps } from "../helpers.js";

const page = (keys: string[], nextPageToken?: string) => ({
  issues: keys.map((key) => issue({ key })),
  responseBytes: 10,
  ...(nextPageToken ? { nextPageToken } : {}),
});

describe("completeness is about retrieval, not about output size", () => {
  it("a preview says it is a preview - not that Jira answered partially", async () => {
    const jira = new FakeJira({ pages: [page(["PROJECT-1"], "t1"), page(["PROJECT-2"])] });

    const result = await searchIssues(testDeps(jira), { jql: "project = PROJECT" });

    expect(jira.searchCalls).toHaveLength(1);
    expect(result.meta.complete).toBe(false);
    expect(result.meta.reason).toBe("PREVIEW_LIMIT");
    expect(result.meta.moreAvailable).toBe(true);
    expect(result.meta.returnedCount).toBe(1);
    expect(result.meta.notes?.[0]).toMatch(/scope="complete"/);
  });

  it("a complete walk that finishes is complete, with nothing left", async () => {
    const jira = new FakeJira({ pages: [page(["PROJECT-1"], "t1"), page(["PROJECT-2"])] });

    const result = await searchIssues(testDeps(jira), { jql: "project = PROJECT", scope: "complete" });

    expect(result.meta.complete).toBe(true);
    expect(result.meta.moreAvailable).toBe(false);
    expect(result.meta.returnedCount).toBe(2);
    expect(result.meta.reason).toBeUndefined();
  });

  it("the page cap is a pagination limit, not a budget", async () => {
    const config = testConfig({ search: { pageSize: 1, maxPages: 2 } });
    const jira = new FakeJira({
      pages: [page(["PROJECT-1"], "t1"), page(["PROJECT-2"], "t2"), page(["PROJECT-3"])],
    });

    const result = await searchIssues(testDeps(jira, config), {
      jql: "project = PROJECT",
      scope: "complete",
    });

    expect(result.meta.reason).toBe("PAGINATION_LIMIT");
    expect(result.meta.complete).toBe(false);
    expect(result.meta.moreAvailable).toBe(true);
  });

  it("a result over the token budget stays complete and says so in notes", async () => {
    const config = testConfig({ output: { searchTokens: 200 } });
    const many = Array.from({ length: 400 }, (_, n) => `PROJECT-${n}`);
    const jira = new FakeJira({ pages: [page(many)] });

    const result = await searchIssues(testDeps(jira, config), {
      jql: "project = PROJECT",
      scope: "complete",
    });

    // 읽기는 끝났다 — 불편한 것은 크기뿐이다.
    expect(result.meta.complete).toBe(true);
    expect(result.meta.moreAvailable).toBe(false);
    expect(result.meta.reason).toBeUndefined();
    expect(result.meta.notes?.some((note) => /token search budget/.test(note))).toBe(true);
  });

  it("both can be true at once and they stay separate", async () => {
    const config = testConfig({ search: { pageSize: 100, maxPages: 1 }, output: { searchTokens: 200 } });
    const many = Array.from({ length: 400 }, (_, n) => `PROJECT-${n}`);
    const jira = new FakeJira({ pages: [page(many, "t1"), page(["PROJECT-X"])] });

    const result = await searchIssues(testDeps(jira, config), {
      jql: "project = PROJECT",
      scope: "complete",
    });

    expect(result.meta.reason).toBe("PAGINATION_LIMIT");
    expect(result.meta.notes?.some((note) => /safety cap/.test(note))).toBe(true);
    expect(result.meta.notes?.some((note) => /token search budget/.test(note))).toBe(true);
  });
});

describe("pagination stays inside JAM", () => {
  it("no continuation token is handed to the caller", async () => {
    const jira = new FakeJira({ pages: [page(["PROJECT-1"], "secret-token"), page(["PROJECT-2"])] });

    const result = await searchIssues(testDeps(jira), { jql: "project = PROJECT" });

    // Passing the token out would move pagination to the agent, which is the
    // one thing this boundary exists to prevent.
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("the JQL is returned to Jira unchanged - JAM does not narrow it", async () => {
    const jira = new FakeJira({ pages: [page(["PROJECT-1"])] });

    await searchIssues(testDeps(jira), { jql: "project = PROJECT AND status != Done" });

    expect(jira.searchCalls[0]?.jql).toBe("project = PROJECT AND status != Done");
  });
});
