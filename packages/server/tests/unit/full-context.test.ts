import { describe, expect, it } from "vitest";
import { getFullIssueContext } from "../../src/application/get-full-issue-context.js";
import { getIssueContext } from "../../src/application/get-issue-context.js";
import { FakeJira, issue, testConfig, testDeps } from "../helpers.js";

const comment = (id: string, body: string) => ({ id, created: `2026-01-0${id}`, body });

describe("jira_context", () => {
  it("batches every key into one round trip and returns dependency structure", async () => {
    const jira = new FakeJira({
      issues: [
        issue({
          key: "PROJECT-101",
          parent: { key: "PROJECT-100" },
          subtasks: [{ key: "PROJECT-102" }],
          links: [
            {
              type: "is blocked by",
              direction: "inward",
              issue: { key: "PROJECT-97" },
              blocksThisIssue: true,
            },
          ],
        }),
      ],
    });
    const result = await getIssueContext(testDeps(jira), {
      issueKeys: ["PROJECT-101", "project-101", "PROJECT-108"],
    });

    expect(jira.issueCalls).toHaveLength(1);
    // duplicates collapsed, keys upper-cased
    expect(jira.issueCalls[0]?.keys).toEqual(["PROJECT-101", "PROJECT-108"]);
    expect(result.issues[0]?.links[0]?.blocksThisIssue).toBe(true);
    expect(result.issues[0]?.parent?.key).toBe("PROJECT-100");
    expect(JSON.stringify(result.issues)).not.toContain("comments");
  });

  it("reports unreadable keys instead of quietly returning fewer issues", async () => {
    const jira = new FakeJira({
      issues: [issue({ key: "PROJECT-101" })],
      missingKeys: ["PROJECT-999"],
    });
    const result = await getIssueContext(testDeps(jira), {
      issueKeys: ["PROJECT-101", "PROJECT-999"],
    });

    expect(result.meta.complete).toBe(false);
    expect(result.meta.reason).toBe("PARTIAL_API_RESPONSE");
    expect(result.meta.missingKeys).toEqual(["PROJECT-999"]);
  });

  it("rejects malformed issue keys", async () => {
    const jira = new FakeJira({});
    await expect(
      getIssueContext(testDeps(jira), { issueKeys: ["not-a-key"] }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("jira_full", () => {
  it("pages the whole comment thread before calling it complete", async () => {
    const jira = new FakeJira({
      issues: [issue({ key: "PROJECT-97", comments: [comment("1", "first")] })],
      commentTotals: { "PROJECT-97": 3 },
      commentPages: {
        "PROJECT-97": [
          { comments: [comment("2", "second")], startAt: 1, total: 3, responseBytes: 5 },
          { comments: [comment("3", "third")], startAt: 2, total: 3, responseBytes: 5 },
        ],
      },
    });
    const result = await getFullIssueContext(testDeps(jira), { issueKeys: ["PROJECT-97"] });

    expect(jira.commentCalls.map((c) => c.startAt)).toEqual([1, 2]);
    expect(result.issues[0]?.comments.map((c) => c.body)).toEqual(["first", "second", "third"]);
    expect(result.meta.commentsComplete).toBe(true);
    expect(result.meta.complete).toBe(true);
  });

  it("marks the thread incomplete when Jira stops returning comments", async () => {
    const jira = new FakeJira({
      issues: [issue({ key: "PROJECT-97", comments: [comment("1", "first")] })],
      commentTotals: { "PROJECT-97": 5 },
      commentPages: { "PROJECT-97": [] },
    });
    const result = await getFullIssueContext(testDeps(jira), { issueKeys: ["PROJECT-97"] });

    expect(result.meta.commentsComplete).toBe(false);
    expect(result.meta.complete).toBe(false);
    expect(result.meta.overflow).toContain("comments");
    expect(result.meta.notes?.join(" ")).toMatch(/not fully retrieved/);
  });

  it("reports budget-dropped comments rather than truncating silently", async () => {
    const config = testConfig({ output: { fullTokens: 200 } });
    const jira = new FakeJira({
      issues: [
        issue({
          key: "PROJECT-97",
          description: "d".repeat(500),
          comments: [comment("1", "x".repeat(500)), comment("2", "final answer")],
        }),
      ],
      commentTotals: { "PROJECT-97": 2 },
    });
    const result = await getFullIssueContext(testDeps(jira, config), { issueKeys: ["PROJECT-97"] });

    expect(result.meta.complete).toBe(false);
    expect(result.meta.reason).toBe("OUTPUT_BUDGET");
    expect(result.meta.overflow).toContain("comments");
    expect(result.meta.commentsComplete).toBe(false);
    expect(result.issues[0]?.comments.at(-1)?.body).toBe("final answer");
  });

  it("includes description and comments in the payload", async () => {
    const jira = new FakeJira({
      issues: [
        issue({ key: "PROJECT-97", description: "Agreed on v2.", comments: [comment("1", "LGTM")] }),
      ],
      commentTotals: { "PROJECT-97": 1 },
    });
    const result = await getFullIssueContext(testDeps(jira), { issueKeys: ["PROJECT-97"] });

    expect(result.issues[0]?.description).toBe("Agreed on v2.");
    expect(result.issues[0]?.comments[0]?.body).toBe("LGTM");
  });
});
