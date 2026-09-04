import { beforeEach, describe, expect, it } from "vitest";
import { applyWritePlan } from "../../src/application/apply-write.js";
import { planWrite } from "../../src/application/plan-write.js";
import { WritePlanStore } from "../../src/application/write-plan-store.js";
import { JamError } from "../../src/domain/errors.js";
import {
  FakeCreateMetadata,
  FakeJira,
  FakeJiraWrite,
  issue,
  testConfig,
  testDeps,
} from "../helpers.js";

/**
 * Applying a create.
 *
 * Everything here is about the two guarantees creation makes that no other
 * write has to: the POST happens exactly once whatever goes wrong, and the
 * issue is read back before anything is called applied. A duplicate update
 * converges; a duplicate create is a second issue on someone's board.
 */
const CREATED_KEY = "PROJECT-500";

const CREATED = () =>
  issue({ key: CREATED_KEY, summary: "Write the thing", issueType: "Task", labels: ["jam"] });

function setup(options: { now?: () => Date; created?: ReturnType<typeof issue> } = {}) {
  const metadata = new FakeCreateMetadata();
  const write = new FakeJiraWrite();
  const jira = new FakeJira({ issues: [options.created ?? CREATED()] });
  const jam = testDeps(
    jira,
    testConfig({ project: { key: "PROJECT" } }),
    write,
    new WritePlanStore(options.now ?? (() => new Date())),
    metadata,
  );
  return { jam, metadata, write, jira };
}

const INPUT = { issueType: "Task", summary: "Write the thing", labels: ["jam"] };

async function plan(ctx: ReturnType<typeof setup>): Promise<string> {
  const { receipt } = await planWrite(ctx.jam, { operation: "issue.create", input: INPUT });
  return receipt.planId;
}

describe("applyWritePlan(issue.create)", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("creates once, and reports the key Jira minted", async () => {
    const planId = await plan(ctx);

    const receipt = await applyWritePlan(ctx.jam, { planId });

    expect(ctx.write.creates).toHaveLength(1);
    expect(receipt).toMatchObject({
      status: "applied",
      operation: "issue.create",
      issue: CREATED_KEY,
      before: { issue: null },
      verified: true,
    });
    expect(receipt.after).toMatchObject({ issueType: "Task", summary: "Write the thing" });
  });

  it("reports the canonical id of the issue Jira made, read back from Jira", async () => {
    const planId = await plan(ctx);

    const receipt = await applyWritePlan(ctx.jam, { planId });

    // The key is how a person will find it; the id is what says the thing they
    // find is the thing that was created. Both come from Jira - the key from
    // the create response, the id confirmed by the verification read that was
    // already happening. Neither is derived from the other, and no extra call
    // was made to get it.
    expect(receipt.issueId).toBe(`id-${CREATED_KEY}`);
    expect(receipt.issue).toBe(CREATED_KEY);
  });

  it("re-reads the schema before sending anything", async () => {
    const planId = await plan(ctx);
    const beforeApply = ctx.metadata.issueTypeCalls.length;

    await applyWritePlan(ctx.jam, { planId });

    // Planning asked once; applying asks again. The second answer is what the
    // create is actually sent against.
    expect(ctx.metadata.issueTypeCalls.length).toBe(beforeApply + 1);
  });

  it("creates nothing when the issue type is no longer offered", async () => {
    const planId = await plan(ctx);
    ctx.metadata.issueTypes = [{ id: "10002", name: "Bug", subtask: false }];

    await expect(applyWritePlan(ctx.jam, { planId })).rejects.toMatchObject({
      code: "JAM_WRITE_SCHEMA_CHANGED",
    });
    expect(ctx.write.creates).toHaveLength(0);
  });

  it("creates nothing when a new required field JAM cannot fill has appeared", async () => {
    const planId = await plan(ctx);
    ctx.metadata.fields = [
      ...ctx.metadata.fields,
      { id: "customfield_777", name: "Team", required: true, hasDefaultValue: false },
    ];

    await expect(applyWritePlan(ctx.jam, { planId })).rejects.toMatchObject({
      code: "JAM_WRITE_SCHEMA_CHANGED",
    });
    expect(ctx.write.creates).toHaveLength(0);
  });

  it("creates nothing when a value it resolved is no longer allowed", async () => {
    const { receipt } = await planWrite(ctx.jam, {
      operation: "issue.create",
      input: { ...INPUT, priority: "High" },
    });
    ctx.metadata.fields = ctx.metadata.fields.map((f) =>
      f.id === "priority" ? { ...f, allowedValues: [{ id: "2", name: "Medium" }] } : f,
    );

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_SCHEMA_CHANGED",
      details: { field: "priority", planned: "High" },
    });
    expect(ctx.write.creates).toHaveLength(0);
  });

  it("still creates when the schema changed in a way the plan never depended on", async () => {
    // Comparing metadata documents would fail here, and would be wrong to: an
    // unrelated optional field appearing on a create screen says nothing about
    // whether this plan is still valid. On an active project that would be a
    // permanent failure rather than an occasional one.
    const planId = await plan(ctx);
    ctx.metadata.fields = [
      ...ctx.metadata.fields,
      { id: "customfield_888", name: "Notes", required: false, hasDefaultValue: false },
    ];
    ctx.metadata.issueTypes = [
      ...ctx.metadata.issueTypes,
      { id: "10009", name: "Spike", subtask: false },
    ];

    await expect(applyWritePlan(ctx.jam, { planId })).resolves.toMatchObject({ verified: true });
  });

  it("confirms by reading the new issue, not by the create response", async () => {
    // Jira answers with a key, and the issue it names says something else.
    ctx = setup({ created: issue({ key: CREATED_KEY, summary: "Something else", issueType: "Task" }) });
    const planId = await plan(ctx);

    await expect(applyWritePlan(ctx.jam, { planId })).rejects.toMatchObject({
      code: "JAM_WRITE_VERIFICATION_FAILED",
      details: { issueKey: CREATED_KEY },
    });
  });

  it("does not require Jira's own defaults to match anything", async () => {
    // Only the fields the create contract lets a caller ask for are compared.
    // A project automation that sets a component nobody requested has not made
    // the create wrong.
    ctx = setup({
      created: issue({
        key: CREATED_KEY,
        summary: "Write the thing",
        issueType: "Task",
        labels: ["jam"],
        components: ["Added by automation"],
        priority: "Medium",
      }),
    });
    const planId = await plan(ctx);

    await expect(applyWritePlan(ctx.jam, { planId })).resolves.toMatchObject({ verified: true });
  });

  it("verifies the description it promised to verify", async () => {
    const description = "First paragraph.\n\nSecond paragraph.";
    ctx = setup({
      created: issue({
        key: CREATED_KEY,
        summary: "Write the thing",
        issueType: "Task",
        labels: ["jam"],
        description,
      }),
    });
    const { receipt } = await planWrite(ctx.jam, {
      operation: "issue.create",
      input: { ...INPUT, description },
    });

    // The receipt promised a direct read would show this. It has to be a
    // promise the check actually keeps.
    expect(receipt.verification.expects).toMatchObject({ description });

    const applied = await applyWritePlan(ctx.jam, { planId: receipt.planId });
    expect(applied.after).toMatchObject({ description });
  });

  it("fails verification when the description never arrived", async () => {
    // The case the skip used to hide: Jira takes the create, drops the
    // description, and the direct read shows none. Reporting verified: true
    // here would be reporting that a field nobody looked at was correct.
    ctx = setup({
      created: issue({
        key: CREATED_KEY,
        summary: "Write the thing",
        issueType: "Task",
        labels: ["jam"],
      }),
    });
    const { receipt } = await planWrite(ctx.jam, {
      operation: "issue.create",
      input: { ...INPUT, description: "This should have been stored." },
    });

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_VERIFICATION_FAILED",
      details: { issueKey: CREATED_KEY, observed: { description: undefined } },
    });
  });

  it("fails verification when the description arrived as something else", async () => {
    ctx = setup({
      created: issue({
        key: CREATED_KEY,
        summary: "Write the thing",
        issueType: "Task",
        labels: ["jam"],
        description: "Something a rule rewrote.",
      }),
    });
    const { receipt } = await planWrite(ctx.jam, {
      operation: "issue.create",
      input: { ...INPUT, description: "What was asked for." },
    });

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_VERIFICATION_FAILED",
    });
  });

  it("does not fail on the formatting the round trip through ADF normalizes", async () => {
    // Jira stores a document and renders it back as text. Blank-line runs
    // collapse and block edges lose their whitespace, and none of that is a
    // difference in what the description says - so a raw string comparison
    // would fail every single create that had one.
    ctx = setup({
      created: issue({
        key: CREATED_KEY,
        summary: "Write the thing",
        issueType: "Task",
        labels: ["jam"],
        description: "First paragraph.\n\nSecond paragraph.",
      }),
    });
    const { receipt } = await planWrite(ctx.jam, {
      operation: "issue.create",
      input: { ...INPUT, description: "  First paragraph.\n\n\n\n   Second paragraph.   \n" },
    });

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).resolves.toMatchObject({
      verified: true,
    });
  });

  it("fails verification when the issue landed in another project", async () => {
    // The workspace binding is the whole of JAM's write scope. A key from
    // somewhere else coming back from a create is the one outcome that must
    // never be reported as the create that was planned.
    ctx = setup();
    ctx.write.createdKey = "OTHER-123";
    const planId = await plan(ctx);

    await expect(applyWritePlan(ctx.jam, { planId })).rejects.toMatchObject({
      code: "JAM_WRITE_VERIFICATION_FAILED",
      details: {
        issueKey: "OTHER-123",
        expected: { project: "PROJECT" },
        observed: { project: "OTHER" },
      },
    });
  });

  it("tells the caller not to create another one when verification fails", async () => {
    ctx = setup({ created: issue({ key: CREATED_KEY, summary: "Wrong", issueType: "Task" }) });
    const planId = await plan(ctx);

    await expect(applyWritePlan(ctx.jam, { planId })).rejects.toThrow(/Do not create another one/);
  });

  it("creates nothing when the plan has expired", async () => {
    let now = new Date();
    ctx = setup({ now: () => now });
    const { receipt } = await planWrite(ctx.jam, { operation: "issue.create", input: INPUT });
    const planId = receipt.planId;
    // Just past the plan's own expiry, whenever that is - the TTL is the
    // subject here, not a particular wall-clock time.
    now = new Date(Date.parse(receipt.expiresAt) + 1_000);

    await expect(applyWritePlan(ctx.jam, { planId })).rejects.toMatchObject({
      code: "JAM_WRITE_PLAN_EXPIRED",
      // No issue key: there is no issue, and naming one would name something
      // that has never existed.
      details: { project: "PROJECT" },
    });
    expect(ctx.write.creates).toHaveLength(0);
  });

  it("creates nothing when the same plan is applied a second time", async () => {
    const planId = await plan(ctx);
    await applyWritePlan(ctx.jam, { planId });

    await expect(applyWritePlan(ctx.jam, { planId })).rejects.toMatchObject({
      code: "JAM_WRITE_PLAN_NOT_FOUND",
    });
    expect(ctx.write.creates).toHaveLength(1);
  });

  it("reports an ambiguous failure as uncertain, and sends nothing again", async () => {
    const planId = await plan(ctx);
    ctx.write.failNext = new JamError("JIRA_UNAVAILABLE", "socket hang up");

    await expect(applyWritePlan(ctx.jam, { planId })).rejects.toMatchObject({
      code: "JAM_WRITE_UNCERTAIN",
      details: { project: "PROJECT", operation: "issue.create" },
    });
    // The create was attempted exactly once. A second attempt is how one
    // ambiguous failure becomes two issues.
    expect(ctx.write.createCalls).toBe(1);
  });

  it("reports a create Jira could not name as uncertain rather than as done", async () => {
    const planId = await plan(ctx);
    ctx.write.createdKey = undefined as unknown as string;

    await expect(applyWritePlan(ctx.jam, { planId })).rejects.toMatchObject({
      code: "JAM_WRITE_UNCERTAIN",
    });
  });

  it("passes a definite Jira refusal through as itself", async () => {
    // A 403 is a decision Jira made and did not act on. Dressing it up as
    // uncertain would send someone looking for an issue that was never made.
    const planId = await plan(ctx);
    ctx.write.failNext = new JamError("JIRA_PERMISSION_DENIED", "no create permission");

    await expect(applyWritePlan(ctx.jam, { planId })).rejects.toMatchObject({
      code: "JIRA_PERMISSION_DENIED",
    });
  });
});
