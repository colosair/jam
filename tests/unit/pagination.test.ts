import { describe, expect, it } from "vitest";
import { searchIssues } from "../../src/application/search-issues.js";
import { FakeJira, issue, testConfig, testDeps } from "../helpers.js";

const page = (keys: string[], nextPageToken?: string) => ({
  issues: keys.map((key) => issue({ key })),
  responseBytes: 10,
  ...(nextPageToken ? { nextPageToken } : {}),
});

describe("search pagination", () => {
  it("preview returns the first page and says it is not the whole set", async () => {
    const jira = new FakeJira({ pages: [page(["PROJECT-1", "PROJECT-2"], "t1"), page(["PROJECT-3"])] });
    const result = await searchIssues(testDeps(jira), { jql: "project = PROJECT" });

    expect(jira.searchCalls).toHaveLength(1);
    expect(result.issues.map((i) => i.key)).toEqual(["PROJECT-1", "PROJECT-2"]);
    expect(result.meta.complete).toBe(false);
    expect(result.meta.overflow).toEqual(["pages"]);
    expect(result.meta.pagesFetched).toBe(1);
  });

  it("complete walks every page to exhaustion", async () => {
    const jira = new FakeJira({
      pages: [page(["PROJECT-1"], "t1"), page(["PROJECT-2"], "t2"), page(["PROJECT-3"])],
    });
    const result = await searchIssues(testDeps(jira), {
      jql: "project = PROJECT",
      scope: "complete",
    });

    expect(jira.searchCalls).toHaveLength(3);
    expect(jira.searchCalls[1]?.pageToken).toBe("t1");
    expect(jira.searchCalls[2]?.pageToken).toBe("t2");
    expect(result.issues.map((i) => i.key)).toEqual(["PROJECT-1", "PROJECT-2", "PROJECT-3"]);
    expect(result.meta.complete).toBe(true);
    expect(result.meta.pagesFetched).toBe(3);
  });

  it("reports the page cap instead of pretending the result is complete", async () => {
    const config = testConfig({ search: { pageSize: 1, maxPages: 2 } });
    const jira = new FakeJira({
      pages: [page(["PROJECT-1"], "t1"), page(["PROJECT-2"], "t2"), page(["PROJECT-3"])],
    });
    const result = await searchIssues(testDeps(jira, config), {
      jql: "project = PROJECT",
      scope: "complete",
    });

    expect(jira.searchCalls).toHaveLength(2);
    expect(result.meta.complete).toBe(false);
    expect(result.meta.reason).toBe("OUTPUT_BUDGET");
    expect(result.meta.notes?.[0]).toMatch(/safety cap/);
  });

  it("never returns description or comments from search", async () => {
    const jira = new FakeJira({
      pages: [
        {
          issues: [
            issue({
              key: "PROJECT-1",
              description: "long description",
              comments: [{ id: "1", created: "2026-01-01", body: "hi" }],
            }),
          ],
          responseBytes: 10,
        },
      ],
    });
    const result = await searchIssues(testDeps(jira), { jql: "project = PROJECT" });
    const serialized = JSON.stringify(result.issues);

    expect(serialized).not.toContain("long description");
    expect(serialized).not.toContain("hi");
    expect(Object.keys(result.issues[0] ?? {})).toEqual([
      "key",
      "summary",
      "status",
      "updated",
      "labels",
      "components",
    ]);
  });
});
