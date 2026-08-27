import { beforeEach, describe, expect, it } from "vitest";
import { applyWritePlan } from "../../src/application/apply-write.js";
import { planWrite } from "../../src/application/plan-write.js";
import { WritePlanStore } from "../../src/application/write-plan-store.js";
import { JamError } from "../../src/domain/errors.js";
import {
  FakeAssignees,
  FakeJira,
  FakeJiraWrite,
  issue,
  testConfig,
  testDeps,
  UnreachableCreateMetadata,
} from "../helpers.js";

/**
 * Assigning an issue to a person.
 *
 * The theme throughout: a name is not an identity. Jira's user search is a
 * substring match, so what it returns is candidates - and JAM assigns only
 * when exactly one of them is certain, verifies the result on the accountId
 * rather than on the display name, and asks Jira twice whether that person may
 * hold the issue at all.
 */
const KEY = "PROJECT-1";
const MIN = "acc-min-kim";

function setup(options: { assignee?: { accountId: string; displayName: string } } = {}) {
  const write = new FakeJiraWrite();
  const assignees = new FakeAssignees();
  const jira = new FakeJira({
    issues: [
      issue({
        key: KEY,
        ...(options.assignee ? { assignee: options.assignee.displayName } : {}),
      }),
    ],
    ...(options.assignee ? { assigneeAccountIds: { [KEY]: options.assignee.accountId } } : {}),
  });

  const jam = testDeps(
    jira,
    testConfig({ project: { key: "PROJECT" } }),
    write,
    new WritePlanStore(),
    new UnreachableCreateMetadata(),
    assignees,
  );
  return { jam, jira, write, assignees };
}

const plan = (ctx: ReturnType<typeof setup>, assignee: string) =>
  planWrite(ctx.jam, { key: KEY, operation: "assignee.update", input: { assignee } });

describe("resolving who was meant", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("resolves an exact display name to that person's accountId", async () => {
    const { receipt } = await plan(ctx, "Min Kim");

    expect(receipt.intendedAfter).toEqual({
      assignee: { accountId: MIN, displayName: "Min Kim" },
    });
  });

  it("treats casing and surrounding space as the same intent", async () => {
    const { receipt } = await plan(ctx, "  min kim ");

    expect(receipt.intendedAfter).toMatchObject({ assignee: { accountId: MIN } });
  });

  it("accepts an accountId the caller already had", async () => {
    const { receipt } = await plan(ctx, MIN);

    expect(receipt.intendedAfter).toMatchObject({ assignee: { accountId: MIN } });
  });

  it("still checks an accountId against Jira rather than trusting the string", async () => {
    // A caller-supplied id is a claim about a person, not proof one exists.
    await expect(plan(ctx, "acc-nobody")).rejects.toMatchObject({
      code: "JAM_WRITE_ASSIGNEE_NOT_FOUND",
    });
    expect(ctx.write.mutations).toBe(0);
  });

  it("refuses when nothing matches, and says so plainly", async () => {
    await expect(plan(ctx, "Nobody At All")).rejects.toMatchObject({
      code: "JAM_WRITE_ASSIGNEE_NOT_FOUND",
      details: { requested: "Nobody At All" },
    });
  });

  it("will not assign on a partial match, even when there is only one", async () => {
    // The failure this whole policy exists to prevent. "Minho" is a substring
    // hit on Minho Park and nobody else, and Jira returning one row is Jira
    // reporting a similarity - not identifying who the caller meant.
    await expect(plan(ctx, "Minho")).rejects.toMatchObject({
      code: "JAM_WRITE_ASSIGNEE_NOT_FOUND",
    });
    expect(ctx.write.mutations).toBe(0);
  });

  it("hands back the candidates so the next attempt can be exact", async () => {
    const error = await plan(ctx, "Min").catch((e: JamError) => e);

    expect(error).toMatchObject({ code: "JAM_WRITE_ASSIGNEE_NOT_FOUND" });
    expect((error as JamError).details?.["candidates"]).toEqual(
      expect.arrayContaining([
        { accountId: MIN, displayName: "Min Kim", active: true },
        { accountId: "acc-minho-park", displayName: "Minho Park", active: true },
      ]),
    );
  });

  it("refuses two people who share a display name, rather than picking one", async () => {
    ctx.assignees.users = [
      { accountId: "acc-a", displayName: "Same Name", active: true },
      { accountId: "acc-b", displayName: "Same Name", active: true },
    ];
    ctx.assignees.assignable = new Set(["acc-a", "acc-b"]);

    const error = await plan(ctx, "Same Name").catch((e: JamError) => e);

    expect(error).toMatchObject({ code: "JAM_WRITE_ASSIGNEE_AMBIGUOUS" });
    expect((error as JamError).details?.["candidates"]).toHaveLength(2);
    expect(ctx.write.mutations).toBe(0);
  });

  it("refuses a deactivated account", async () => {
    await expect(plan(ctx, "Departed Person")).rejects.toMatchObject({
      code: "JAM_WRITE_ASSIGNEE_NOT_ASSIGNABLE",
      details: { reason: "INACTIVE" },
    });
  });
});

describe("planning an assignment", () => {
  it("needs a key, because there is an issue to change", async () => {
    const ctx = setup();

    await expect(
      planWrite(ctx.jam, { operation: "assignee.update", input: { assignee: "Min Kim" } }),
    ).rejects.toMatchObject({ code: "JAM_WRITE_OPERATION_NOT_ALLOWED" });
  });

  it("stays inside the configured project", async () => {
    const ctx = setup();

    await expect(
      planWrite(ctx.jam, {
        key: "OTHER-1",
        operation: "assignee.update",
        input: { assignee: "Min Kim" },
      }),
    ).rejects.toMatchObject({ code: "JAM_WRITE_SCOPE_VIOLATION" });
    expect(ctx.assignees.searches).toHaveLength(0);
  });

  it("reads the issue through the single-issue GET", async () => {
    const ctx = setup();

    await plan(ctx, "Min Kim");

    expect(ctx.jira.directIssueCalls.map((c) => c.key)).toEqual([KEY]);
    expect(ctx.jira.issueCalls).toHaveLength(0);
    expect(ctx.jira.directIssueCalls[0]!.fields).toContain("assignee");
  });

  it("reports who holds the issue now, by identity", async () => {
    const ctx = setup({ assignee: { accountId: "acc-minho-park", displayName: "Minho Park" } });

    const { receipt } = await plan(ctx, "Min Kim");

    expect(receipt.before).toEqual({
      assignee: { accountId: "acc-minho-park", displayName: "Minho Park" },
    });
  });

  it("says so when the issue is unassigned, rather than inventing a name", async () => {
    const ctx = setup();

    const { receipt } = await plan(ctx, "Min Kim");

    expect(receipt.before).toEqual({ assignee: null });
  });

  it("checks Jira offers this person for this issue before planning anything", async () => {
    const ctx = setup();
    ctx.assignees.assignable = new Set(["acc-minho-park"]);

    await expect(plan(ctx, "Min Kim")).rejects.toMatchObject({
      code: "JAM_WRITE_ASSIGNEE_NOT_ASSIGNABLE",
      details: { issueKey: KEY, accountId: MIN },
    });
    expect(ctx.write.mutations).toBe(0);
  });

  it("refuses an assignment that would change nothing", async () => {
    const ctx = setup({ assignee: { accountId: MIN, displayName: "Min Kim" } });

    await expect(plan(ctx, "Min Kim")).rejects.toMatchObject({
      code: "JAM_WRITE_ASSIGNEE_ALREADY_SET",
      details: { accountId: MIN },
    });
  });

  it("writes nothing while planning", async () => {
    const ctx = setup();

    await plan(ctx, "Min Kim");

    expect(ctx.write.mutations).toBe(0);
  });

  it("promises to verify exactly what it intends", async () => {
    const ctx = setup();

    const { receipt } = await plan(ctx, "Min Kim");

    expect(receipt.verification).toEqual({
      method: "direct-issue-read",
      expects: receipt.intendedAfter,
    });
  });

  it("is not reachable through field.update", async () => {
    // Assignment has its own resolution rules and its own Jira endpoint.
    // Letting it in through the field whitelist would bypass both.
    const ctx = setup();

    await expect(
      planWrite(ctx.jam, {
        key: KEY,
        operation: "field.update",
        input: { assignee: "Min Kim" },
      }),
    ).rejects.toMatchObject({
      code: "JAM_WRITE_FIELD_NOT_ALLOWED",
      details: { rejected: ["assignee"] },
    });
  });
});

describe("applying an assignment", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("assigns once, by accountId, and confirms it by reading back", async () => {
    const { receipt } = await plan(ctx, "Min Kim");
    ctx.jira.setAssignee(KEY, MIN, "Min Kim");

    const applied = await applyWritePlan(ctx.jam, { planId: receipt.planId });

    expect(ctx.write.assignments).toEqual([{ key: KEY, accountId: MIN }]);
    expect(applied).toMatchObject({
      status: "applied",
      issue: KEY,
      operation: "assignee.update",
      verified: true,
    });
    expect(applied.after).toEqual({ assignee: { accountId: MIN, displayName: "Min Kim" } });
  });

  it("asks again whether the person may still hold the issue", async () => {
    const { receipt } = await plan(ctx, "Min Kim");
    const checksAfterPlan = ctx.assignees.assignableChecks.length;
    ctx.jira.setAssignee(KEY, MIN, "Min Kim");

    await applyWritePlan(ctx.jam, { planId: receipt.planId });

    expect(ctx.assignees.assignableChecks.length).toBe(checksAfterPlan + 1);
  });

  it("assigns nothing when the permission was revoked after planning", async () => {
    const { receipt } = await plan(ctx, "Min Kim");
    ctx.assignees.assignable = new Set(["acc-minho-park"]);

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_ASSIGNEE_NOT_ASSIGNABLE",
    });
    expect(ctx.write.assignments).toHaveLength(0);
  });

  it("assigns nothing when the issue moved after planning", async () => {
    const { receipt } = await plan(ctx, "Min Kim");
    ctx.jira.setUpdated(KEY, "2026-08-27T23:59:00.000+0900");

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_CONFLICT",
    });
    expect(ctx.write.assignments).toHaveLength(0);
  });

  it("fails verification when somebody else ended up holding the issue", async () => {
    // The case a display-name comparison would get wrong if the two people
    // shared a name - and the reason identity is what gets compared.
    const { receipt } = await plan(ctx, "Min Kim");
    ctx.jira.setAssignee(KEY, "acc-minho-park", "Min Kim");

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_VERIFICATION_FAILED",
      details: {
        expected: { assignee: { accountId: MIN } },
        observed: { assignee: { accountId: "acc-minho-park" } },
      },
    });
  });

  it("fails verification when the assignment did not land at all", async () => {
    const { receipt } = await plan(ctx, "Min Kim");

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_VERIFICATION_FAILED",
      details: { observed: { assignee: null } },
    });
  });

  it("assigns nothing when the same plan is applied twice", async () => {
    const { receipt } = await plan(ctx, "Min Kim");
    ctx.jira.setAssignee(KEY, MIN, "Min Kim");
    await applyWritePlan(ctx.jam, { planId: receipt.planId });

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_PLAN_NOT_FOUND",
    });
    expect(ctx.write.assignments).toHaveLength(1);
  });

  it("reports an ambiguous failure as uncertain, and sends nothing again", async () => {
    const { receipt } = await plan(ctx, "Min Kim");
    ctx.write.failNext = new JamError("JIRA_UNAVAILABLE", "socket hang up");

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_UNCERTAIN",
      details: { issueKey: KEY, operation: "assignee.update" },
    });
    expect(ctx.write.assignCalls).toBe(1);
  });
});
