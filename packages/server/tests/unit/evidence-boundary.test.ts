import { describe, expect, it } from "vitest";
import { getFullIssueContext } from "../../src/application/get-full-issue-context.js";
import { getIssueContext } from "../../src/application/get-issue-context.js";
import { FakeJira, issue, testDeps } from "../helpers.js";

/**
 * The shape that caused this work: an issue in progress whose Jira record is
 * empty of structure. JAM retrieved everything Jira had, and a reader took
 * that to mean nothing blocks the work - which JAM never checked and cannot
 * check. These tests pin the difference in the payload rather than in prose.
 */
describe("evidence boundary", () => {
  const inProgressWithNothingLinked = () =>
    new FakeJira({
      issues: [issue({ key: "PROJECT-101", status: "In Progress", subtasks: [], links: [] })],
    });

  it("reports a complete read of an empty dependency picture as exactly that", async () => {
    const result = await getIssueContext(testDeps(inProgressWithNothingLinked()), {
      issueKeys: ["PROJECT-101"],
    });

    // Everything Jira held was retrieved, and Jira held no links.
    expect(result.meta.complete).toBe(true);
    expect(result.meta.linksComplete).toBe(true);
    expect(result.issues[0]!.links).toEqual([]);
    expect(result.issues[0]!.subtasks).toEqual([]);

    expect(result.meta.source).toBe("jira");
    expect(result.meta.evidenceScope).toBe("jira-records-only");
    expect(result.meta.limitations).toContain("REPOSITORY_NOT_EVALUATED");
    expect(result.meta.limitations).toContain("EXTERNAL_SOURCES_NOT_EVALUATED");
    expect(result.meta.limitations).toContain("NON_JIRA_DEPENDENCIES_NOT_EVALUATED");
  });

  it("never turns that into a readiness verdict", async () => {
    const result = await getFullIssueContext(testDeps(inProgressWithNothingLinked()), {
      issueKeys: ["PROJECT-101"],
    });

    // JAM reports what Jira holds. Any of these fields would be JAM claiming
    // something about the work itself, which is a different system's job.
    const meta = result.meta as Record<string, unknown>;
    const first = result.issues[0]! as unknown as Record<string, unknown>;
    for (const invented of ["ready", "dependencyFree", "repositoryComplete", "stale"]) {
      expect(meta).not.toHaveProperty(invented);
      expect(first).not.toHaveProperty(invented);
    }
  });

  it("says a full read with no comments proves only that Jira has none", async () => {
    const result = await getFullIssueContext(testDeps(inProgressWithNothingLinked()), {
      issueKeys: ["PROJECT-101"],
    });

    expect(result.meta.commentsComplete).toBe(true);
    expect(result.issues[0]!.comments).toEqual([]);
    // No thread means no timestamp, rather than a fabricated one.
    expect(result.issues[0]!.latestCommentAt).toBeUndefined();
    expect(result.meta.evidenceScope).toBe("jira-records-only");
  });
});

describe("latestCommentAt", () => {
  it("takes the newest timestamp, not the last comment in the list", async () => {
    const jira = new FakeJira({
      issues: [
        issue({
          key: "PROJECT-97",
          comments: [
            // Out of order, and the newest moment belongs to an edit of the
            // first comment - both of which a "last element" rule gets wrong.
            {
              id: "1",
              created: "2026-08-01T09:00:00.000+0900",
              updated: "2026-08-20T09:00:00.000+0900",
              body: "Agreed, with one change.",
            },
            { id: "2", created: "2026-08-10T09:00:00.000+0900", body: "Ack." },
          ],
        }),
      ],
      commentTotals: { "PROJECT-97": 2 },
    });

    const result = await getFullIssueContext(testDeps(jira), { issueKeys: ["PROJECT-97"] });

    expect(result.issues[0]!.latestCommentAt).toBe("2026-08-20T09:00:00.000+0900");
  });

  it("compares moments rather than text, so an offset cannot outrank a Z", async () => {
    const jira = new FakeJira({
      issues: [
        issue({
          key: "PROJECT-97",
          comments: [
            // 09:00+0900 is 00:00Z - earlier than 08:00Z, though it sorts
            // after it as a string.
            { id: "1", created: "2026-08-21T08:00:00.000Z", body: "First." },
            { id: "2", created: "2026-08-21T09:00:00.000+0900", body: "Second." },
          ],
        }),
      ],
      commentTotals: { "PROJECT-97": 2 },
    });

    const result = await getFullIssueContext(testDeps(jira), { issueKeys: ["PROJECT-97"] });

    expect(result.issues[0]!.latestCommentAt).toBe("2026-08-21T08:00:00.000Z");
  });
});
