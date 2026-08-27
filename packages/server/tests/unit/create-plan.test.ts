import { beforeEach, describe, expect, it } from "vitest";
import { planWrite } from "../../src/application/plan-write.js";
import { WritePlanStore } from "../../src/application/write-plan-store.js";
import type { CreateIssueWritePlan } from "../../src/domain/write.js";
import {
  FakeCreateMetadata,
  FakeJira,
  FakeJiraWrite,
  testConfig,
  testDeps,
  issue,
} from "../helpers.js";

/**
 * Planning a create.
 *
 * The theme of every case: JAM decides from the schema Jira just reported, and
 * refuses anything it cannot express - before a create is sent, not after Jira
 * rejects one. Nothing here may reach a write port, which is what the
 * `mutations` assertions are for.
 */
function deps(metadata = new FakeCreateMetadata(), write = new FakeJiraWrite()) {
  return {
    jam: testDeps(
      new FakeJira({ issues: [issue({ key: "PROJECT-1" })] }),
      testConfig({ project: { key: "PROJECT" } }),
      write,
      new WritePlanStore(),
      metadata,
    ),
    metadata,
    write,
  };
}

const VALID = { issueType: "Task", summary: "Write the thing" };

describe("planWrite(issue.create)", () => {
  let ctx: ReturnType<typeof deps>;

  beforeEach(() => {
    ctx = deps();
  });

  it("plans a create against the configured project, without a key", async () => {
    const { receipt, plan } = await planWrite(ctx.jam, {
      operation: "issue.create",
      input: { ...VALID, labels: ["jam"] },
    });

    expect(receipt.status).toBe("planned");
    expect(receipt.project).toBe("PROJECT");
    // No issue exists yet, so the receipt names none - a placeholder key here
    // would be a claim JAM cannot make.
    expect(receipt.issue).toBeUndefined();
    expect(receipt.before).toEqual({ issue: null });
    expect(receipt.intendedAfter).toEqual({
      issueType: "Task",
      summary: "Write the thing",
      labels: ["jam"],
    });
    expect(receipt.verification).toMatchObject({ method: "direct-issue-read" });
    expect(plan.kind).toBe("create-issue");
    expect(ctx.metadata.issueTypeCalls).toEqual(["PROJECT"]);
  });

  it("uses the workspace binding, and does not accept a project from the caller", async () => {
    await expect(
      planWrite(ctx.jam, { operation: "issue.create", input: { ...VALID, project: "OTHER" } }),
    ).rejects.toMatchObject({ code: "JAM_WRITE_FIELD_NOT_ALLOWED" });
  });

  it("writes nothing while planning", async () => {
    await planWrite(ctx.jam, { operation: "issue.create", input: VALID });

    expect(ctx.write.mutations).toBe(0);
  });

  it("resolves the issue type to the id Jira gave, never one derived from the name", async () => {
    const { plan } = await planWrite(ctx.jam, {
      operation: "issue.create",
      // Casing is the agent's guess; the id is Jira's answer.
      input: { ...VALID, issueType: "task" },
    });

    const created = plan as CreateIssueWritePlan;
    expect(created.schemaRequirements.issueTypeId).toBe("10001");
    expect(created.mutation).toMatchObject({
      kind: "create",
      fields: { issuetype: { id: "10001" }, project: { key: "PROJECT" } },
    });
    expect(ctx.metadata.fieldCalls).toEqual([{ projectKey: "PROJECT", issueTypeId: "10001" }]);
  });

  it("refuses an issue type Jira does not offer, and says what it does", async () => {
    await expect(
      planWrite(ctx.jam, { operation: "issue.create", input: { ...VALID, issueType: "Epic" } }),
    ).rejects.toMatchObject({
      code: "JAM_WRITE_ISSUE_TYPE_NOT_AVAILABLE",
      details: { requested: "Epic" },
    });
  });

  it("refuses a subtask type, because it has no parent to give it", async () => {
    await expect(
      planWrite(ctx.jam, { operation: "issue.create", input: { ...VALID, issueType: "Subtask" } }),
    ).rejects.toMatchObject({
      code: "JAM_WRITE_ISSUE_TYPE_NOT_AVAILABLE",
      details: { reason: "SUBTASK_UNSUPPORTED" },
    });
  });

  it("refuses when the create screen requires a field JAM cannot express", async () => {
    ctx.metadata.fields = [
      ...ctx.metadata.fields,
      { id: "customfield_12345", name: "Team", required: true, hasDefaultValue: false },
    ];

    await expect(
      planWrite(ctx.jam, { operation: "issue.create", input: VALID }),
    ).rejects.toMatchObject({
      code: "JAM_WRITE_REQUIRED_FIELD_UNSUPPORTED",
      details: { unsupported: [{ id: "customfield_12345", reason: "NOT_IN_JAM_CREATE_CONTRACT" }] },
    });
    expect(ctx.write.mutations).toBe(0);
  });

  it("accepts a required field Jira says it will default, rather than guessing at it", async () => {
    // A default is Jira stating a fact about its own configuration. Treating
    // that as JAM's to supply would be the guess; refusing it would refuse a
    // create Jira is perfectly willing to make.
    ctx.metadata.fields = [
      ...ctx.metadata.fields,
      { id: "customfield_999", name: "Sprint", required: true, hasDefaultValue: true },
    ];

    const { receipt } = await planWrite(ctx.jam, { operation: "issue.create", input: VALID });

    expect(receipt.status).toBe("planned");
  });

  it("accepts a required field JAM can set once it has actually been asked for", async () => {
    ctx.metadata.fields = ctx.metadata.fields.map((f) =>
      f.id === "description" ? { ...f, required: true } : f,
    );

    await expect(
      planWrite(ctx.jam, { operation: "issue.create", input: VALID }),
    ).rejects.toMatchObject({
      details: { unsupported: [{ id: "description", reason: "REQUIRED_BUT_NOT_PROVIDED" }] },
    });

    const { receipt } = await planWrite(ctx.jam, {
      operation: "issue.create",
      input: { ...VALID, description: "why" },
    });
    expect(receipt.status).toBe("planned");
  });

  it("refuses a priority outside the allowed values, and lists the ones there are", async () => {
    await expect(
      planWrite(ctx.jam, { operation: "issue.create", input: { ...VALID, priority: "Urgent" } }),
    ).rejects.toMatchObject({
      code: "JAM_WRITE_VALUE_NOT_ALLOWED",
      details: { field: "priority", requested: "Urgent", allowed: ["High", "Medium", "Low"] },
    });
  });

  it("refuses a component outside the allowed values", async () => {
    await expect(
      planWrite(ctx.jam, {
        operation: "issue.create",
        input: { ...VALID, components: ["Backend", "Nowhere"] },
      }),
    ).rejects.toMatchObject({
      code: "JAM_WRITE_VALUE_NOT_ALLOWED",
      details: { field: "components", requested: "Nowhere" },
    });
  });

  it("records the values it resolved, so apply can check they are still offered", async () => {
    const { plan } = await planWrite(ctx.jam, {
      operation: "issue.create",
      input: { ...VALID, priority: "high", components: ["backend"] },
    });

    const created = plan as CreateIssueWritePlan;
    expect(created.schemaRequirements.resolvedValues).toEqual([
      { fieldId: "priority", requested: "high", resolved: "High" },
      { fieldId: "components", requested: "backend", resolved: "Backend" },
    ]);
    // The mutation carries Jira's casing, not the caller's.
    expect(created.mutation).toMatchObject({
      fields: { priority: { name: "High" }, components: [{ name: "Backend" }] },
    });
  });

  it("refuses an empty summary", async () => {
    await expect(
      planWrite(ctx.jam, { operation: "issue.create", input: { ...VALID, summary: "   " } }),
    ).rejects.toMatchObject({ code: "JAM_WRITE_OPERATION_NOT_ALLOWED" });
  });

  it("refuses fields outside the create contract instead of dropping them", async () => {
    // Silently ignoring a field an agent asked for would create an issue that
    // is not the one it described, and the receipt would not say so.
    await expect(
      planWrite(ctx.jam, {
        operation: "issue.create",
        input: { ...VALID, assignee: "someone", customfield_1: "x" },
      }),
    ).rejects.toMatchObject({
      code: "JAM_WRITE_FIELD_NOT_ALLOWED",
      details: { rejected: ["assignee", "customfield_1"] },
    });
  });

  it("refuses an ADF description, and converts a plain-text one itself", async () => {
    await expect(
      planWrite(ctx.jam, {
        operation: "issue.create",
        input: { ...VALID, description: { type: "doc", version: 1, content: [] } },
      }),
    ).rejects.toMatchObject({ code: "JAM_WRITE_OPERATION_NOT_ALLOWED" });

    const { plan } = await planWrite(ctx.jam, {
      operation: "issue.create",
      input: { ...VALID, description: "plain words" },
    });
    expect((plan as CreateIssueWritePlan).mutation).toMatchObject({
      fields: {
        description: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "plain words" }] }],
        },
      },
    });
  });

  it("promises the description a direct read can actually show", async () => {
    // `intendedAfter` is what `verification.expects` promises. A direct read
    // returns the text as Jira renders it back, so promising the caller's
    // exact bytes would be promising something no read can produce - and the
    // check would then have to be skipped, which is how this went wrong.
    const { receipt } = await planWrite(ctx.jam, {
      operation: "issue.create",
      input: { ...VALID, description: "  One.\n\n\n\nTwo.   \n" },
    });

    expect(receipt.intendedAfter).toMatchObject({ description: "One.\n\nTwo." });
    expect(receipt.verification.expects).toEqual(receipt.intendedAfter);
  });

  it("refuses a description that is only whitespace", async () => {
    // It renders to nothing, so no direct read could ever confirm it.
    await expect(
      planWrite(ctx.jam, { operation: "issue.create", input: { ...VALID, description: "   \n  " } }),
    ).rejects.toMatchObject({ code: "JAM_WRITE_OPERATION_NOT_ALLOWED" });
  });

  it("refuses an existing-issue operation that arrived without a key", async () => {
    await expect(
      planWrite(ctx.jam, { operation: "comment.add", input: { text: "hi" } }),
    ).rejects.toMatchObject({ code: "JAM_WRITE_OPERATION_NOT_ALLOWED" });
  });
});
