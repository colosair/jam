import { describe, expect, it } from "vitest";
import { applyWritePlan } from "../../src/application/apply-write.js";
import { planWrite } from "../../src/application/plan-write.js";
import { WritePlanStore } from "../../src/application/write-plan-store.js";
import type { JamDeps } from "../../src/deps.js";
import type { FullIssueContext } from "../../src/domain/context.js";
import { JamError } from "../../src/domain/errors.js";
import type {
  GetCommentsRequest,
  GetCommentsResult,
  GetIssueRequest,
  GetIssueResult,
  GetIssuesRequest,
  GetIssuesResult,
  JiraReadPort,
  ListProjectsResult,
  SearchPageRequest,
  SearchPageResult,
} from "../../src/ports/jira-read.port.js";
import { FakeJiraWrite, issue, testConfig, testDeps } from "../helpers.js";

/**
 * Applying is the half that changes something, so these tests are about the
 * three ways it must refuse: the issue moved, Jira does not show the result,
 * and JAM cannot tell what happened. The last one carries the invariant that
 * matters most - an ambiguous write is never retried, because the first
 * attempt may already have landed.
 */

/**
 * A read port whose issue can change between reads.
 *
 * Apply reads the issue twice - once to check the plan still holds, once to
 * confirm the result - so a fake that answers identically both times cannot
 * express either failure this suite is about.
 */
class MutableJira implements JiraReadPort {
  readonly reads: GetIssueRequest[] = [];
  constructor(private current: FullIssueContext) {}

  set(next: Partial<FullIssueContext>): void {
    this.current = { ...this.current, ...next };
  }

  async getIssue(req: GetIssueRequest): Promise<GetIssueResult> {
    this.reads.push(req);
    const snapshot = { ...this.current, comments: [...this.current.comments] };
    return { issue: snapshot, responseBytes: 100 };
  }

  async getIssues(_req: GetIssuesRequest): Promise<GetIssuesResult> {
    // ConsistencyPolicy calls for a direct issue GET around a write, and the
    // bulk endpoint is not one. Reaching it here would mean the write plane
    // had quietly gone back to it.
    throw new Error("apply must confirm a write with a direct issue GET, not bulkfetch");
  }

  async searchPage(_req: SearchPageRequest): Promise<SearchPageResult> {
    throw new Error("apply must never confirm a write with a search");
  }
  async getComments(req: GetCommentsRequest): Promise<GetCommentsResult> {
    return { comments: [], startAt: req.startAt, total: 0, responseBytes: 0 };
  }
  async getCurrentUser() {
    return { accountId: "acc-1" };
  }
  async listProjects(): Promise<ListProjectsResult> {
    return { projects: [], truncated: false };
  }
}

function setup(overrides: Partial<FullIssueContext> = {}, transitions: FakeJiraWrite["transitions"] = []) {
  const jira = new MutableJira(
    issue({
      key: "PROJECT-1",
      summary: "Wire the auth endpoint",
      status: "In Progress",
      labels: ["backend"],
      updated: "2026-08-25T12:00:00.000+0900",
      ...overrides,
    }),
  );
  const jiraWrite = new FakeJiraWrite({ transitions });
  const deps: JamDeps = testDeps(jira, testConfig(), jiraWrite, new WritePlanStore());
  return { jira, jiraWrite, deps };
}

async function failure(fn: () => Promise<unknown>): Promise<JamError> {
  try {
    await fn();
  } catch (err) {
    return err as JamError;
  }
  throw new Error("expected a JamError, but the call succeeded");
}

describe("a write is pinned to an issue, not to a key", () => {
  it("records the canonical id at plan time and reports it in both receipts", async () => {
    const { jira, deps } = setup({ issueId: "10001" });
    const { plan, receipt: planned } = await planWrite(deps, {
      key: "PROJECT-1",
      operation: "field.update",
      input: { labels: ["backend", "mvp1"] },
    });

    expect(planned.issue).toBe("PROJECT-1");
    expect(planned.issueId).toBe("10001");

    jira.set({ labels: ["backend", "mvp1"] });
    const applied = await applyWritePlan(deps, { planId: plan.planId });

    expect(applied).toMatchObject({ issue: "PROJECT-1", issueId: "10001", verified: true });
  });

  it("refuses when the key has come to name a different issue", async () => {
    const { jira, jiraWrite, deps } = setup({ issueId: "10001" });
    const { plan } = await planWrite(deps, {
      key: "PROJECT-1",
      operation: "comment.add",
      input: { text: "Contract updated." },
    });

    // The key still resolves and the revision is untouched - and it is not the
    // issue that was planned. A key is a locator Jira can move; only the id
    // says whether the target is the same thing.
    jira.set({ issueId: "20002" });

    const err = await failure(() => applyWritePlan(deps, { planId: plan.planId }));

    expect(err.code).toBe("JAM_WRITE_CONFLICT");
    expect(err.details).toMatchObject({ plannedIssueId: "10001", observedIssueId: "20002" });
    // Refused before the mutation, not after it.
    expect(jiraWrite.mutations).toBe(0);
  });

  it("will not build a plan on an issue Jira named no id for", async () => {
    const { deps } = setup({ issueId: undefined });

    const err = await failure(() =>
      planWrite(deps, { key: "PROJECT-1", operation: "comment.add", input: { text: "hi" } }),
    );

    expect(err.code).toBe("PARTIAL_RESULT");
    expect(err.message).toMatch(/canonical issue id/);
  });

  it("costs no extra Jira read - identity travels on the reads a write already makes", async () => {
    const { jira, deps } = setup({ issueId: "10001" });
    const { plan } = await planWrite(deps, {
      key: "PROJECT-1",
      operation: "field.update",
      input: { summary: "Wire the auth endpoint properly" },
    });
    jira.set({ summary: "Wire the auth endpoint properly" });
    await applyWritePlan(deps, { planId: plan.planId });

    // Plan, apply preflight, post-write verify. The same three reads as before
    // identity existed - each now also answers which issue it read.
    expect(jira.reads.length).toBe(3);
  });
});

describe("a write that lands", () => {
  it("adds the comment and confirms it by reading the thread back", async () => {
    const { jira, jiraWrite, deps } = setup();
    const { plan } = await planWrite(deps, {
      key: "PROJECT-1",
      operation: "comment.add",
      input: { text: "Contract updated." },
    });

    // Jira now shows the comment, which is what makes this a success.
    jira.set({ comments: [{ id: "c1", created: "2026-08-26", body: "Contract updated." }] });

    const receipt = await applyWritePlan(deps, { planId: plan.planId });

    expect(receipt).toMatchObject({
      status: "applied",
      issue: "PROJECT-1",
      operation: "comment.add",
      verified: true,
      commentId: "comment-1",
    });
    expect(jiraWrite.comments).toEqual([{ key: "PROJECT-1", body: "Contract updated." }]);
  });

  it("updates fields and reports what the issue actually shows afterwards", async () => {
    const { jira, jiraWrite, deps } = setup();
    const { plan } = await planWrite(deps, {
      key: "PROJECT-1",
      operation: "field.update",
      input: { labels: ["backend", "mvp1"] },
    });

    jira.set({ labels: ["backend", "mvp1"] });
    const receipt = await applyWritePlan(deps, { planId: plan.planId });

    expect(receipt.before).toEqual({ labels: ["backend"] });
    expect(receipt.after).toEqual({ labels: ["backend", "mvp1"] });
    expect(jiraWrite.updates).toEqual([
      { key: "PROJECT-1", fields: { labels: ["backend", "mvp1"] } },
    ]);
  });

  it("transitions by the id the plan resolved, not by the status name", async () => {
    const { jira, jiraWrite, deps } = setup({}, [{ id: "31", name: "Done", to: "완료" }]);
    const { plan } = await planWrite(deps, {
      key: "PROJECT-1",
      operation: "status.transition",
      input: { status: "완료" },
    });

    jira.set({ status: "완료" });
    const receipt = await applyWritePlan(deps, { planId: plan.planId });

    expect(receipt.after).toEqual({ status: "완료" });
    expect(jiraWrite.transitionCalls).toEqual([{ key: "PROJECT-1", transitionId: "31" }]);
  });

  it("retires the plan, so the same receipt cannot mutate twice", async () => {
    const { jira, jiraWrite, deps } = setup();
    const { plan } = await planWrite(deps, {
      key: "PROJECT-1",
      operation: "comment.add",
      input: { text: "once" },
    });
    jira.set({ comments: [{ id: "c1", created: "2026-08-26", body: "once" }] });
    await applyWritePlan(deps, { planId: plan.planId });

    // Replaying an applied plan would be a second comment.
    expect((await failure(() => applyWritePlan(deps, { planId: plan.planId }))).code).toBe(
      "JAM_WRITE_PLAN_NOT_FOUND",
    );
    expect(jiraWrite.comments).toHaveLength(1);
  });
});

describe("a write that must not happen", () => {
  it("refuses when the issue moved after the plan was made", async () => {
    const { jira, jiraWrite, deps } = setup();
    const { plan } = await planWrite(deps, {
      key: "PROJECT-1",
      operation: "field.update",
      input: { summary: "New summary" },
    });

    // Somebody else edited the issue in between.
    jira.set({ updated: "2026-08-25T13:00:00.000+0900" });

    const error = await failure(() => applyWritePlan(deps, { planId: plan.planId }));
    expect(error.code).toBe("JAM_WRITE_CONFLICT");
    expect(jiraWrite.mutations).toBe(0);
  });

  it("refuses an expired plan, and says to re-plan rather than that it is missing", async () => {
    const { jira, jiraWrite, deps } = setup();
    let now = new Date();
    const store = new WritePlanStore(() => now);
    const withStore: JamDeps = { ...deps, writePlans: store };

    const { plan } = await planWrite(withStore, {
      key: "PROJECT-1",
      operation: "comment.add",
      input: { text: "late" },
    });

    // Just past the plan's own expiry, whenever that is - the TTL is the
    // subject here, not a particular wall-clock time.
    now = new Date(Date.parse(plan.expiresAt) + 1_000);
    const error = await failure(() => applyWritePlan(withStore, { planId: plan.planId }));

    expect(error.code).toBe("JAM_WRITE_PLAN_EXPIRED");
    expect(jiraWrite.mutations).toBe(0);
    expect(jira.reads).toHaveLength(1); // the plan's own read, and no more
  });

  it("refuses a planId it never issued", async () => {
    const { deps } = setup();
    expect((await failure(() => applyWritePlan(deps, { planId: "made-up" }))).code).toBe(
      "JAM_WRITE_PLAN_NOT_FOUND",
    );
  });
});

describe("a write Jira accepted but the issue does not show", () => {
  it("fails verification rather than reporting success", async () => {
    const { jiraWrite, deps } = setup({}, [{ id: "31", name: "Done", to: "완료" }]);
    const { plan } = await planWrite(deps, {
      key: "PROJECT-1",
      operation: "status.transition",
      input: { status: "완료" },
    });

    // Jira took the transition, but a workflow rule left the issue elsewhere.
    const error = await failure(() => applyWritePlan(deps, { planId: plan.planId }));

    expect(error.code).toBe("JAM_WRITE_VERIFICATION_FAILED");
    expect(error.details).toMatchObject({
      expected: { status: "완료" },
      observed: { status: "In Progress" },
    });
    expect(jiraWrite.transitionCalls).toHaveLength(1);
  });

  it("will not accept somebody else's comment as proof of ours", async () => {
    const { jira, deps } = setup();
    const { plan } = await planWrite(deps, {
      key: "PROJECT-1",
      operation: "comment.add",
      input: { text: "ours" },
    });

    // A comment appeared - just not the one JAM wrote. A count would pass here.
    jira.set({ comments: [{ id: "c9", created: "2026-08-26", body: "somebody else's" }] });

    expect((await failure(() => applyWritePlan(deps, { planId: plan.planId }))).code).toBe(
      "JAM_WRITE_VERIFICATION_FAILED",
    );
  });
});

describe("a write whose outcome is unknown", () => {
  it("reports uncertainty and does not retry the mutation", async () => {
    const { jiraWrite, deps } = setup();
    const { plan } = await planWrite(deps, {
      key: "PROJECT-1",
      operation: "comment.add",
      input: { text: "maybe sent" },
    });

    // The shape of the dangerous case: the request may have reached Jira.
    jiraWrite.failNext = new JamError("JIRA_UNAVAILABLE", "socket hang up");

    const error = await failure(() => applyWritePlan(deps, { planId: plan.planId }));

    expect(error.code).toBe("JAM_WRITE_UNCERTAIN");
    expect(error.message).toContain("do not retry");
    // One attempt. A second would be how one comment becomes two.
    expect(jiraWrite.comments).toHaveLength(0);
    expect(jiraWrite.mutations).toBe(0);
  });

  it("leaves a definite refusal definite", async () => {
    const { jiraWrite, deps } = setup();
    const { plan } = await planWrite(deps, {
      key: "PROJECT-1",
      operation: "comment.add",
      input: { text: "nope" },
    });

    // Jira decided, and did not act. Nothing ambiguous about it.
    jiraWrite.failNext = new JamError("JIRA_PERMISSION_DENIED", "no permission");

    expect((await failure(() => applyWritePlan(deps, { planId: plan.planId }))).code).toBe(
      "JIRA_PERMISSION_DENIED",
    );
  });
});
