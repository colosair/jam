// Jira identity, as it travels from a raw payload to what an agent reads.
//
// A Jira issue key is a locator that can be reassigned; the numeric id Jira
// mints is the identity. JAM already received that id on every issue payload
// and dropped it, which left an agent holding only a string that another issue
// can later come to own. These tests pin the id all the way through, pin the
// status category to Jira's own machine-readable key rather than to a guess
// about a localized name, and pin the cost: none of it may add a Jira request.

import { describe, expect, it } from "vitest";
import { mapIssueWithMeta } from "../../src/adapters/jira-cloud/mapper.js";
import { getFullIssueContext } from "../../src/application/get-full-issue-context.js";
import { getIssueContext } from "../../src/application/get-issue-context.js";
import { searchIssues } from "../../src/application/search-issues.js";
import { FakeJira, issue, testConfig, testDeps } from "../helpers.js";

const config = testConfig();

const status = (name: string, category: string) => ({
  name,
  statusCategory: { id: 3, key: category, name: "Done" },
});

describe("identity in the mapper", () => {
  it("carries Jira's issue id onto the mapped issue", () => {
    const { issue: mapped } = mapIssueWithMeta(
      { key: "PROJECT-101", id: "10101", fields: { summary: "Example" } },
      config,
    );
    expect(mapped.issueId).toBe("10101");
    expect(mapped.key).toBe("PROJECT-101");
  });

  it("never invents an id when Jira did not send one", () => {
    const { issue: mapped } = mapIssueWithMeta({ key: "PROJECT-101", fields: {} }, config);
    // Not "" - an empty string reads as an identity that was checked and found
    // blank, when in fact none was returned at all.
    expect(mapped.issueId).toBeUndefined();
    expect("issueId" in mapped).toBe(false);
  });

  it("takes the status category from Jira's key, not from the status name", () => {
    const { issue: mapped } = mapIssueWithMeta(
      { key: "PROJECT-101", id: "1", fields: { status: status("완료", "done") } },
      config,
    );
    expect(mapped.status).toBe("완료");
    expect(mapped.statusCategory).toBe("done");
  });

  it("reports no category rather than deriving one from a localized name", () => {
    const { issue: mapped } = mapIssueWithMeta(
      { key: "PROJECT-101", id: "1", fields: { status: { name: "Done" } } },
      config,
    );
    expect(mapped.status).toBe("Done");
    expect(mapped.statusCategory).toBeUndefined();
  });

  it("keeps identity on parent, subtasks and links", () => {
    const { issue: mapped } = mapIssueWithMeta(
      {
        key: "PROJECT-101",
        id: "10101",
        fields: {
          parent: { id: "10001", key: "PROJECT-1", fields: { summary: "Epic" } },
          subtasks: [
            { id: "10202", key: "PROJECT-202", fields: { status: status("Done", "done") } },
          ],
          issuelinks: [
            {
              type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
              inwardIssue: { id: "10303", key: "PROJECT-303", fields: {} },
            },
          ],
        },
      },
      config,
    );

    expect(mapped.parent).toMatchObject({ key: "PROJECT-1", issueId: "10001" });
    expect(mapped.subtasks[0]).toMatchObject({
      key: "PROJECT-202",
      issueId: "10202",
      statusCategory: "done",
    });
    expect(mapped.links[0]!.issue).toMatchObject({ key: "PROJECT-303", issueId: "10303" });
  });

  it("leaves a nested reference without an id undecided rather than guessing", () => {
    const { issue: mapped } = mapIssueWithMeta(
      { key: "PROJECT-101", id: "1", fields: { parent: { key: "PROJECT-1" } } },
      config,
    );
    expect(mapped.parent).toEqual({ key: "PROJECT-1" });
  });
});

describe("identity across the three read levels", () => {
  const fixture = issue({
    key: "PROJECT-101",
    issueId: "10101",
    statusCategory: "indeterminate",
    parent: { key: "PROJECT-1", issueId: "10001" },
  });

  it("jira_search returns identity alongside the key", async () => {
    const jira = new FakeJira({ pages: [{ issues: [fixture], responseBytes: 10 }] });
    const { issues, meta } = await searchIssues(testDeps(jira), { jql: "project = PROJECT" });
    expect(issues[0]).toMatchObject({
      key: "PROJECT-101",
      issueId: "10101",
      statusCategory: "indeterminate",
    });
    // The existing contract is untouched by the additions.
    expect(meta.level).toBe("search");
    expect(meta.complete).toBe(true);
  });

  it("jira_context returns identity, and keeps it on nested references", async () => {
    const jira = new FakeJira({ issues: [fixture] });
    const { issues, meta } = await getIssueContext(testDeps(jira), { issueKeys: ["PROJECT-101"] });
    expect(issues[0]).toMatchObject({ key: "PROJECT-101", issueId: "10101" });
    expect(issues[0]!.parent).toMatchObject({ key: "PROJECT-1", issueId: "10001" });
    expect(meta.level).toBe("context");
  });

  it("jira_full returns identity without losing the thread contract", async () => {
    const jira = new FakeJira({
      issues: [issue({ key: "PROJECT-97", issueId: "10097", statusCategory: "done" })],
      commentTotals: { "PROJECT-97": 0 },
    });
    const { issues, meta } = await getFullIssueContext(testDeps(jira), {
      issueKeys: ["PROJECT-97"],
    });
    expect(issues[0]).toMatchObject({
      key: "PROJECT-97",
      issueId: "10097",
      statusCategory: "done",
    });
    expect(meta.commentsComplete).toBe(true);
  });
});

describe("a key that did not resolve", () => {
  it("is reported as missing, and never as available", async () => {
    const jira = new FakeJira({
      issues: [issue({ key: "PROJECT-101", issueId: "10101" })],
      missingKeys: ["PROJECT-999"],
    });
    const { issues, meta } = await getIssueContext(testDeps(jira), {
      issueKeys: ["PROJECT-101", "PROJECT-999"],
    });

    expect(issues.map((i) => i.key)).toEqual(["PROJECT-101"]);
    expect(meta.missingKeys).toEqual(["PROJECT-999"]);
    expect(meta.complete).toBe(false);
    // The note says the key could not be read. It must not say, or let anyone
    // infer, that the number is unused - a key JAM cannot see is a key JAM
    // knows nothing about.
    expect(meta.notes?.join(" ")).toMatch(/could not be read/);
    expect(JSON.stringify(meta)).not.toMatch(/available|unused|free|reservable/i);
  });
});

describe("cost of identity", () => {
  it("adds no Jira request at context level, and no per-reference lookup", async () => {
    const jira = new FakeJira({
      issues: [
        issue({
          key: "PROJECT-101",
          issueId: "10101",
          parent: { key: "PROJECT-1", issueId: "10001" },
          subtasks: [
            { key: "PROJECT-2", issueId: "10002" },
            { key: "PROJECT-3", issueId: "10003" },
          ],
          links: [
            {
              type: "blocks",
              direction: "outward",
              issue: { key: "PROJECT-4", issueId: "10004" },
              blocksThisIssue: false,
            },
          ],
        }),
      ],
    });

    await getIssueContext(testDeps(jira), { issueKeys: ["PROJECT-101"] });

    // One bulk fetch, and nothing else. Four nested references carrying an id
    // is four references JAM did not have to go and ask about.
    expect(jira.issueCalls.length).toBe(1);
    expect(jira.directIssueCalls.length).toBe(0);
    expect(jira.commentCalls.length).toBe(0);
  });

  it("asks Jira for no extra field to get identity or status semantics", async () => {
    const jira = new FakeJira({ issues: [issue({ key: "PROJECT-101", issueId: "10101" })] });
    await getIssueContext(testDeps(jira), { issueKeys: ["PROJECT-101"] });

    // `id` and `key` are properties of the issue resource, not fields, and the
    // status category arrives inside the `status` field that was always asked
    // for. So the field list is exactly what it was before identity existed.
    expect(jira.issueCalls[0]!.fields).toEqual([
      "summary",
      "status",
      "assignee",
      "priority",
      "updated",
      "labels",
      "components",
      "parent",
      "subtasks",
      "issuelinks",
      "issuetype",
    ]);
  });
});
