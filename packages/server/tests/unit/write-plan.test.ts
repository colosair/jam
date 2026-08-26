import { describe, expect, it } from "vitest";
import { planWrite } from "../../src/application/plan-write.js";
import { JamError } from "../../src/domain/errors.js";
import { FakeJira, FakeJiraWrite, issue, testConfig, testDeps } from "../helpers.js";

/**
 * Planning is the half that decides, and it must not write.
 *
 * The tests below are mostly about refusals, because that is where the value
 * is: a plan that goes through is one Jira round trip, but a plan that should
 * not have gone through is a change to someone's issue tracker.
 */

function deps(options: { transitions?: FakeJiraWrite["transitions"]; issues?: ReturnType<typeof issue>[] } = {}) {
  const jira = new FakeJira({
    issues: options.issues ?? [
      issue({
        key: "PROJECT-1",
        summary: "Wire the auth endpoint",
        status: "In Progress",
        priority: "High",
        labels: ["backend"],
        components: ["API"],
        updated: "2026-08-25T12:00:00.000+0900",
      }),
    ],
  });
  const jiraWrite = new FakeJiraWrite({ transitions: options.transitions ?? [] });
  return { jira, jiraWrite, deps: testDeps(jira, testConfig(), jiraWrite) };
}

async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as JamError).code;
  }
  throw new Error("expected a JamError, but the call succeeded");
}

describe("planning a comment", () => {
  it("describes the addition without touching Jira", async () => {
    const { jiraWrite, deps: d } = deps();

    const { receipt } = await planWrite(d, {
      key: "PROJECT-1",
      operation: "comment.add",
      input: { text: "Contract updated." },
    });

    expect(receipt.status).toBe("planned");
    expect(receipt.issue).toBe("PROJECT-1");
    expect(receipt.intendedAfter).toEqual({ commentAdded: "Contract updated." });
    expect(receipt.verification.method).toBe("direct-issue-read");
    expect(jiraWrite.mutations).toBe(0);
  });

  it("refuses an empty comment before spending a Jira call on it", async () => {
    const { deps: d } = deps();
    expect(await code(() => planWrite(d, { key: "PROJECT-1", operation: "comment.add", input: { text: "  " } }))).toBe(
      "JAM_WRITE_OPERATION_NOT_ALLOWED",
    );
  });

  it("does not expose the mutation in the receipt", async () => {
    const { deps: d } = deps();
    const { receipt, plan } = await planWrite(d, {
      key: "PROJECT-1",
      operation: "comment.add",
      input: { text: "hello" },
    });

    // The mutation is what apply will send. It stays in the process; the agent
    // gets a handle to it, not the thing itself.
    expect(JSON.stringify(receipt)).not.toContain("mutation");
    expect(plan.mutation).toEqual({ kind: "comment", text: "hello" });
  });
});

describe("planning a field update", () => {
  it("reports the current value beside the intended one", async () => {
    const { deps: d } = deps();

    const { receipt } = await planWrite(d, {
      key: "PROJECT-1",
      operation: "field.update",
      input: { summary: "Wire the auth endpoint (v2)", labels: ["backend", "mvp1"] },
    });

    expect(receipt.before).toEqual({
      summary: "Wire the auth endpoint",
      labels: ["backend"],
    });
    expect(receipt.intendedAfter).toEqual({
      summary: "Wire the auth endpoint (v2)",
      labels: ["backend", "mvp1"],
    });
  });

  it("refuses a field outside the whitelist", async () => {
    const { jira, deps: d } = deps();

    const failure = await code(() =>
      planWrite(d, {
        key: "PROJECT-1",
        operation: "field.update",
        input: { assignee: "someone" } as Record<string, unknown>,
      }),
    );

    expect(failure).toBe("JAM_WRITE_FIELD_NOT_ALLOWED");
    // Refused on JAM's own terms, before Jira was asked anything.
    expect(jira.issueCalls).toHaveLength(0);
  });

  it("refuses an update that names no field at all", async () => {
    const { deps: d } = deps();
    expect(await code(() => planWrite(d, { key: "PROJECT-1", operation: "field.update", input: {} }))).toBe(
      "JAM_WRITE_FIELD_NOT_ALLOWED",
    );
  });

  it("maps whitelisted values onto the shapes Jira's field API wants", async () => {
    const { deps: d } = deps();
    const { plan } = await planWrite(d, {
      key: "PROJECT-1",
      operation: "field.update",
      input: { priority: "Highest", components: ["API", "Web"] },
    });

    expect(plan.mutation).toEqual({
      kind: "fields",
      fields: {
        priority: { name: "Highest" },
        components: [{ name: "API" }, { name: "Web" }],
      },
    });
  });
});

describe("planning a status transition", () => {
  it("resolves the transition id from what Jira currently offers", async () => {
    const { jiraWrite, deps: d } = deps({
      transitions: [
        { id: "31", name: "Done", to: "완료" },
        { id: "21", name: "Start", to: "진행 중" },
      ],
    });

    const { receipt, plan } = await planWrite(d, {
      key: "PROJECT-1",
      operation: "status.transition",
      input: { status: "완료" },
    });

    expect(receipt.before).toEqual({ status: "In Progress" });
    expect(receipt.intendedAfter).toEqual({ status: "완료" });
    expect(plan.transition).toEqual({ id: "31", name: "Done", to: "완료" });
    expect(jiraWrite.mutations).toBe(0);
  });

  it("refuses a status Jira does not offer, and says what it does", async () => {
    const { deps: d } = deps({ transitions: [{ id: "21", name: "Start", to: "진행 중" }] });

    let error: JamError | undefined;
    try {
      await planWrite(d, { key: "PROJECT-1", operation: "status.transition", input: { status: "Done" } });
    } catch (err) {
      error = err as JamError;
    }

    expect(error?.code).toBe("JAM_WRITE_TRANSITION_NOT_AVAILABLE");
    // The agent's next move is to pick a reachable one, so the reachable ones
    // travel with the refusal.
    expect(error?.message).toContain("진행 중");
  });

  it("refuses when the account can make no transition at all", async () => {
    const { deps: d } = deps({ transitions: [] });
    expect(
      await code(() => planWrite(d, { key: "PROJECT-1", operation: "status.transition", input: { status: "Done" } })),
    ).toBe("JAM_WRITE_TRANSITION_NOT_AVAILABLE");
  });
});

describe("what planning refuses outright", () => {
  it("rejects an issue in another project", async () => {
    const { jiraWrite, deps: d } = deps();

    const failure = await code(() =>
      planWrite(d, { key: "OTHER-55", operation: "comment.add", input: { text: "hi" } }),
    );

    expect(failure).toBe("JAM_WRITE_SCOPE_VIOLATION");
    expect(jiraWrite.mutations).toBe(0);
  });

  it("rejects an unsupported operation", async () => {
    const { deps: d } = deps();
    expect(await code(() => planWrite(d, { key: "PROJECT-1", operation: "issue.delete", input: {} }))).toBe(
      "JAM_WRITE_OPERATION_NOT_ALLOWED",
    );
  });

  it("rejects a key that is not a Jira key", async () => {
    const { deps: d } = deps();
    expect(await code(() => planWrite(d, { key: "../../etc/passwd", operation: "comment.add", input: { text: "x" } }))).toBe(
      "JAM_WRITE_SCOPE_VIOLATION",
    );
  });

  it("reports a missing issue as missing rather than planning against nothing", async () => {
    const { deps: d } = deps({ issues: [] });
    expect(await code(() => planWrite(d, { key: "PROJECT-9", operation: "comment.add", input: { text: "x" } }))).toBe(
      "ISSUE_NOT_FOUND",
    );
  });
});
