import { beforeEach, describe, expect, it } from "vitest";
import { applyWritePlan } from "../../src/application/apply-write.js";
import { planWrite } from "../../src/application/plan-write.js";
import { WritePlanStore } from "../../src/application/write-plan-store.js";
import { ProjectConfigSchema } from "../../src/config/schema.js";
import { JamError } from "../../src/domain/errors.js";
import {
  FakeEditMetadata,
  FakeJira,
  FakeJiraWrite,
  issue,
  testConfig,
  testDeps,
  UnreachableAssignees,
  UnreachableCreateMetadata,
} from "../helpers.js";

/**
 * Writing a custom field.
 *
 * Three permissions have to line up, and none implies another: the team opted
 * this exact field in, Jira will let this account set it on this issue, and
 * JAM knows the type well enough to produce a value and recognise it
 * afterwards. Every case here is one of those three saying no, or all three
 * saying yes.
 */
const KEY = "PROJECT-1";

const WRITABLE = [
  { id: "customfield_10100", name: "Notes", writable: true },
  { id: "customfield_10016", name: "Story Points", writable: true },
  { id: "customfield_10200", name: "Category", writable: true },
  { id: "customfield_10021", name: "Flagged", writable: true },
  { id: "customfield_10015", name: "Start date", writable: true },
  { id: "customfield_10019", name: "Rank", writable: true },
  // Deliberately readable and not writable - the distinction under test.
  { id: "customfield_10300", name: "Read Only Notes" },
];

function setup(customFields = WRITABLE) {
  const write = new FakeJiraWrite();
  const metadata = new FakeEditMetadata();
  const jira = new FakeJira({ issues: [issue({ key: KEY })] });
  const jam = testDeps(
    jira,
    testConfig({ project: { key: "PROJECT" }, customFields }),
    write,
    new WritePlanStore(),
    new UnreachableCreateMetadata(),
    new UnreachableAssignees(),
    metadata,
  );
  return { jam, jira, write, metadata };
}

const plan = (ctx: ReturnType<typeof setup>, field: string, value: unknown) =>
  planWrite(ctx.jam, {
    key: KEY,
    operation: "custom-field.update",
    input: { field, value } as Record<string, unknown>,
  });

describe("reading a custom field is not writing one", () => {
  it("refuses a field the project never opted in", async () => {
    const ctx = setup();

    await expect(plan(ctx, "customfield_99999", "x")).rejects.toMatchObject({
      code: "JAM_WRITE_FIELD_NOT_ALLOWED",
      details: { requested: "customfield_99999" },
    });
    // Refused before a Jira call: the whitelist is knowable without asking.
    expect(ctx.metadata.calls).toHaveLength(0);
    expect(ctx.write.mutations).toBe(0);
  });

  it("refuses a whitelisted field that was never marked writable", async () => {
    // The whole point of the second consent. This field is readable, on the
    // edit screen, a supported type, and still refused.
    const ctx = setup();

    await expect(plan(ctx, "customfield_10300", "x")).rejects.toMatchObject({
      code: "JAM_WRITE_FIELD_NOT_ALLOWED",
    });
    expect(ctx.metadata.calls).toHaveLength(0);
  });

  it("names the writable fields, and only those, when refusing", async () => {
    const ctx = setup();

    const error = await plan(ctx, "Nope", "x").catch((e: JamError) => e);

    const offered = (error as JamError).details?.["writableCustomFields"] as { id: string }[];
    expect(offered.map((f) => f.id)).not.toContain("customfield_10300");
    expect(offered.map((f) => f.id)).toContain("customfield_10100");
  });

  it("says so plainly when no field is writable at all", async () => {
    const ctx = setup([{ id: "customfield_10100", name: "Notes" }]);

    await expect(plan(ctx, "Notes", "x")).rejects.toThrow(/being readable does not make a field writable/i);
  });

  it("resolves a configured id or a configured name, exactly", async () => {
    const ctx = setup();

    await expect(plan(ctx, "customfield_10100", "hello")).resolves.toBeTruthy();
    await expect(plan(ctx, "Notes", "hello")).resolves.toBeTruthy();
    await expect(plan(ctx, "  notes  ", "hello")).resolves.toBeTruthy();
  });

  it("refuses a partial name rather than guessing which field was meant", async () => {
    const ctx = setup();

    await expect(plan(ctx, "Note", "hello")).rejects.toMatchObject({
      code: "JAM_WRITE_FIELD_NOT_ALLOWED",
    });
    await expect(plan(ctx, "Story", 3)).rejects.toMatchObject({
      code: "JAM_WRITE_FIELD_NOT_ALLOWED",
    });
  });
});

describe("what Jira says about this issue", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("refuses a field that is not on this issue's edit screen", async () => {
    ctx.metadata.set("customfield_10100", undefined);

    await expect(plan(ctx, "Notes", "hello")).rejects.toMatchObject({
      code: "JAM_WRITE_CUSTOM_FIELD_NOT_EDITABLE",
      details: { reason: "NOT_ON_EDIT_SCREEN" },
    });
    expect(ctx.write.mutations).toBe(0);
  });

  it("refuses a field Jira will not let this account set", async () => {
    // Present on the screen, but only addable and removable. JAM sets values;
    // it does not add to or remove from one.
    ctx.metadata.set("customfield_10021", {
      ...ctx.metadata.find("customfield_10021")!,
      operations: ["add", "remove"],
    });

    await expect(plan(ctx, "Flagged", ["Impediment"])).rejects.toMatchObject({
      code: "JAM_WRITE_CUSTOM_FIELD_NOT_EDITABLE",
      details: { reason: "SET_NOT_OFFERED", operations: ["add", "remove"] },
    });
  });

  it("refuses a type it does not know how to write", async () => {
    // A date needs a timezone policy JAM does not have; a lexorank means
    // nothing outside the board that owns it. Neither is posted to find out.
    await expect(plan(ctx, "Start date", "2026-08-27")).rejects.toMatchObject({
      code: "JAM_WRITE_CUSTOM_FIELD_TYPE_UNSUPPORTED",
      details: { fieldId: "customfield_10015" },
    });
    await expect(plan(ctx, "Rank", "0|i0000:")).rejects.toMatchObject({
      code: "JAM_WRITE_CUSTOM_FIELD_TYPE_UNSUPPORTED",
    });
    expect(ctx.write.mutations).toBe(0);
  });

  it("refuses a select whose options Jira did not describe", async () => {
    ctx.metadata.set("customfield_10200", {
      ...ctx.metadata.find("customfield_10200")!,
      allowedValues: undefined as never,
    });

    await expect(plan(ctx, "Category", "Backend")).rejects.toMatchObject({
      code: "JAM_WRITE_CUSTOM_FIELD_TYPE_UNSUPPORTED",
    });
  });
});

describe("the value, checked against the family", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("writes text as text", async () => {
    const { receipt, plan: p } = await plan(ctx, "Notes", "  hello  ");

    expect(receipt.intendedAfter).toEqual({
      customField: { id: "customfield_10100", name: "Notes", value: "hello" },
    });
    expect(p.mutation).toMatchObject({ fieldId: "customfield_10100", value: "hello" });
  });

  it("writes a number as a number", async () => {
    const { plan: p } = await plan(ctx, "Story Points", 5);

    expect(p.mutation).toMatchObject({ fieldId: "customfield_10016", value: 5 });
  });

  it("does not convert between types", async () => {
    // "5" and 5 are different values, and guessing which was meant is not
    // JAM's to do - a caller who meant a number can say so.
    await expect(plan(ctx, "Story Points", "5")).rejects.toMatchObject({
      code: "JAM_WRITE_VALUE_NOT_ALLOWED",
      details: { kind: "number", received: "string" },
    });
    await expect(plan(ctx, "Notes", 5)).rejects.toMatchObject({
      code: "JAM_WRITE_VALUE_NOT_ALLOWED",
      details: { kind: "text" },
    });
  });

  it("refuses shapes the contract never admitted", async () => {
    for (const value of [null, true, { id: "10012" }, ["a", 1]]) {
      await expect(plan(ctx, "Notes", value)).rejects.toMatchObject({
        code: "JAM_WRITE_OPERATION_NOT_ALLOWED",
      });
    }
  });

  it("does not clear a field by accident", async () => {
    // Removing a value is a different intent from setting one, and it is not
    // in this version - so it is refused rather than inferred from emptiness.
    await expect(plan(ctx, "Notes", "   ")).rejects.toMatchObject({
      code: "JAM_WRITE_VALUE_NOT_ALLOWED",
      details: { reason: "CLEAR_NOT_SUPPORTED" },
    });
    await expect(plan(ctx, "Flagged", [])).rejects.toMatchObject({
      details: { reason: "CLEAR_NOT_SUPPORTED" },
    });
  });

  it("resolves a single option to its id, by label or by id", async () => {
    const byLabel = await plan(ctx, "Category", "Backend");
    const byId = await plan(ctx, "Category", "10012");
    const byCase = await plan(ctx, "Category", "  backend ");

    for (const { plan: p, receipt } of [byLabel, byId, byCase]) {
      expect(p.mutation).toMatchObject({ value: { id: "10012" } });
      expect(receipt.intendedAfter).toEqual({
        customField: {
          id: "customfield_10200",
          name: "Category",
          value: { id: "10012", label: "Backend" },
        },
      });
    }
  });

  it("refuses an option Jira does not offer, and lists the ones it does", async () => {
    await expect(plan(ctx, "Category", "Sideways")).rejects.toMatchObject({
      code: "JAM_WRITE_VALUE_NOT_ALLOWED",
      details: { requested: "Sideways" },
    });
  });

  it("refuses two options that share a label", async () => {
    ctx.metadata.set("customfield_10200", {
      ...ctx.metadata.find("customfield_10200")!,
      allowedValues: [
        { id: "1", label: "Same" },
        { id: "2", label: "Same" },
      ],
    });

    await expect(plan(ctx, "Category", "Same")).rejects.toMatchObject({
      code: "JAM_WRITE_VALUE_NOT_ALLOWED",
    });
  });

  it("resolves every option of a multi-select, or none of them", async () => {
    const { plan: p } = await plan(ctx, "Flagged", ["Impediment", "Blocked"]);
    expect(p.mutation).toMatchObject({ value: [{ id: "10019" }, { id: "10020" }] });

    // One bad entry refuses the whole thing. A partly-applied selection is a
    // selection nobody asked for.
    await expect(plan(ctx, "Flagged", ["Impediment", "Nonsense"])).rejects.toMatchObject({
      code: "JAM_WRITE_VALUE_NOT_ALLOWED",
      details: { requested: "Nonsense" },
    });
    expect(ctx.write.mutations).toBe(0);
  });

  it("refuses a repeated option rather than quietly dropping it", async () => {
    await expect(plan(ctx, "Flagged", ["Impediment", "impediment"])).rejects.toMatchObject({
      code: "JAM_WRITE_VALUE_NOT_ALLOWED",
      details: { repeated: "impediment" },
    });
  });
});

describe("planning a custom-field update", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("needs a key, and stays inside the configured project", async () => {
    await expect(
      planWrite(ctx.jam, {
        operation: "custom-field.update",
        input: { field: "Notes", value: "x" },
      }),
    ).rejects.toMatchObject({ code: "JAM_WRITE_OPERATION_NOT_ALLOWED" });

    await expect(
      planWrite(ctx.jam, {
        key: "OTHER-1",
        operation: "custom-field.update",
        input: { field: "Notes", value: "x" },
      }),
    ).rejects.toMatchObject({ code: "JAM_WRITE_SCOPE_VIOLATION" });
  });

  it("reads the issue once, asking for the field it is about to change", async () => {
    await plan(ctx, "Notes", "hello");

    expect(ctx.jira.directIssueCalls).toHaveLength(1);
    expect(ctx.jira.directIssueCalls[0]!.fields).toContain("customfield_10100");
    expect(ctx.jira.issueCalls).toHaveLength(0);
  });

  it("reports what the field holds now, in the shape it will hold after", async () => {
    ctx.jira.setCustomField(KEY, "customfield_10200", { id: "10013", value: "Frontend" });

    const { receipt } = await plan(ctx, "Category", "Backend");

    expect(receipt.before).toEqual({
      customField: {
        id: "customfield_10200",
        name: "Category",
        value: { id: "10013", label: "Frontend" },
      },
    });
  });

  it("says the field is empty rather than inventing a value", async () => {
    const { receipt } = await plan(ctx, "Notes", "hello");

    expect(receipt.before).toEqual({
      customField: { id: "customfield_10100", name: "Notes", value: null },
    });
  });

  it("freezes the premises apply will re-derive", async () => {
    const { plan: p } = await plan(ctx, "Flagged", ["Impediment"]);

    expect(p.customFieldRequirements).toEqual({
      fieldId: "customfield_10021",
      fieldName: "Flagged",
      kind: "multi-option",
      schema: { type: "array", items: "option", custom: "multicheckboxes" },
      resolvedOptions: [{ id: "10019", label: "Impediment" }],
    });
  });

  it("writes nothing while planning, and promises what it will check", async () => {
    const { receipt } = await plan(ctx, "Notes", "hello");

    expect(ctx.write.mutations).toBe(0);
    expect(receipt.verification).toEqual({
      method: "direct-issue-read",
      expects: receipt.intendedAfter,
    });
  });

  it("leaves field.update's whitelist exactly as it was", async () => {
    await expect(
      planWrite(ctx.jam, {
        key: KEY,
        operation: "field.update",
        input: { customfield_10100: "hello" },
      }),
    ).rejects.toMatchObject({ code: "JAM_WRITE_FIELD_NOT_ALLOWED" });
  });
});

describe("applying a custom-field update", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  async function applied(field: string, value: unknown, observed: unknown) {
    const { receipt } = await plan(ctx, field, value);
    const fieldId = (receipt.intendedAfter["customField"] as { id: string }).id;
    ctx.jira.setCustomField(KEY, fieldId, observed);
    return applyWritePlan(ctx.jam, { planId: receipt.planId });
  }

  it("writes once, through the ordinary issue edit, and confirms by reading back", async () => {
    const receipt = await applied("Notes", "hello", "hello");

    expect(ctx.write.updates).toEqual([
      { key: KEY, fields: { customfield_10100: "hello" } },
    ]);
    expect(receipt).toMatchObject({ status: "applied", operation: "custom-field.update", verified: true });
    expect(receipt.after).toEqual({
      customField: { id: "customfield_10100", name: "Notes", value: "hello" },
    });
  });

  it("confirms a number", async () => {
    const receipt = await applied("Story Points", 5, 5);

    expect(receipt.after).toMatchObject({ customField: { value: 5 } });
  });

  it("confirms an option by its id, not by its label", async () => {
    // The label is what a person reads. Two options can carry the same one,
    // which is why identity is what gets compared.
    const receipt = await applied("Category", "Backend", { id: "10012", value: "Backend" });

    expect(receipt.after).toMatchObject({
      customField: { value: { id: "10012", label: "Backend" } },
    });
  });

  it("accepts a multi-select Jira returned in another order", async () => {
    const receipt = await applied(
      "Flagged",
      ["Impediment", "Blocked"],
      [
        { id: "10020", value: "Blocked" },
        { id: "10019", value: "Impediment" },
      ],
    );

    expect(receipt.verified).toBe(true);
  });

  it("re-derives the field's premises before writing", async () => {
    const { receipt } = await plan(ctx, "Notes", "hello");
    const afterPlan = ctx.metadata.calls.length;
    ctx.jira.setCustomField(KEY, "customfield_10100", "hello");

    await applyWritePlan(ctx.jam, { planId: receipt.planId });

    expect(ctx.metadata.calls.length).toBe(afterPlan + 1);
  });

  it("writes nothing when the issue moved after planning", async () => {
    const { receipt } = await plan(ctx, "Notes", "hello");
    ctx.jira.setUpdated(KEY, "2026-08-28T00:00:00.000+0900");

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_CONFLICT",
    });
    expect(ctx.write.mutations).toBe(0);
  });

  it("writes nothing when the field left the edit screen", async () => {
    const { receipt } = await plan(ctx, "Notes", "hello");
    ctx.metadata.set("customfield_10100", undefined);

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_SCHEMA_CHANGED",
    });
    expect(ctx.write.mutations).toBe(0);
  });

  it("writes nothing when set stopped being offered", async () => {
    const { receipt } = await plan(ctx, "Notes", "hello");
    ctx.metadata.set("customfield_10100", {
      ...ctx.metadata.find("customfield_10100")!,
      operations: [],
    });

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_SCHEMA_CHANGED",
    });
    expect(ctx.write.mutations).toBe(0);
  });

  it("writes nothing when the field changed type", async () => {
    const { receipt } = await plan(ctx, "Notes", "hello");
    ctx.metadata.set("customfield_10100", {
      ...ctx.metadata.find("customfield_10100")!,
      schema: { type: "number" },
    });

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_SCHEMA_CHANGED",
    });
    expect(ctx.write.mutations).toBe(0);
  });

  it("writes nothing when a chosen option was removed", async () => {
    const { receipt } = await plan(ctx, "Category", "Backend");
    ctx.metadata.set("customfield_10200", {
      ...ctx.metadata.find("customfield_10200")!,
      allowedValues: [{ id: "10013", label: "Frontend" }],
    });

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_SCHEMA_CHANGED",
    });
    expect(ctx.write.mutations).toBe(0);
  });

  it("writes nothing when a chosen option was renamed", async () => {
    // The id still matches, so the write would land - but the plan showed a
    // human "Backend", and "Platform" is a different statement about the issue.
    const { receipt } = await plan(ctx, "Category", "Backend");
    ctx.metadata.set("customfield_10200", {
      ...ctx.metadata.find("customfield_10200")!,
      allowedValues: [
        { id: "10012", label: "Platform" },
        { id: "10013", label: "Frontend" },
      ],
    });

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_SCHEMA_CHANGED",
    });
    expect(ctx.write.mutations).toBe(0);
  });

  it("still writes when the screen changed in a way the plan never rested on", async () => {
    const { receipt } = await plan(ctx, "Notes", "hello");
    ctx.metadata.set("customfield_10999", {
      id: "customfield_10999",
      name: "Something New",
      required: false,
      operations: ["set"],
      schema: { type: "string" },
    });
    ctx.jira.setCustomField(KEY, "customfield_10100", "hello");

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).resolves.toMatchObject({
      verified: true,
    });
  });

  it("fails verification when the field holds something else", async () => {
    const { receipt } = await plan(ctx, "Notes", "hello");
    ctx.jira.setCustomField(KEY, "customfield_10100", "something else");

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_VERIFICATION_FAILED",
    });
  });

  it("fails verification when an option landed on a different id", async () => {
    const { receipt } = await plan(ctx, "Category", "Backend");
    ctx.jira.setCustomField(KEY, "customfield_10200", { id: "10013", value: "Backend" });

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_VERIFICATION_FAILED",
    });
  });

  it("writes nothing when the same plan is applied twice", async () => {
    const { receipt } = await plan(ctx, "Notes", "hello");
    ctx.jira.setCustomField(KEY, "customfield_10100", "hello");
    await applyWritePlan(ctx.jam, { planId: receipt.planId });

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_PLAN_NOT_FOUND",
    });
    expect(ctx.write.updates).toHaveLength(1);
  });

  it("reports an ambiguous failure as uncertain, and sends nothing again", async () => {
    const { receipt } = await plan(ctx, "Notes", "hello");
    ctx.write.failNext = new JamError("JIRA_UNAVAILABLE", "socket hang up");

    await expect(applyWritePlan(ctx.jam, { planId: receipt.planId })).rejects.toMatchObject({
      code: "JAM_WRITE_UNCERTAIN",
      details: { issueKey: KEY, operation: "custom-field.update" },
    });
    expect(ctx.write.updates).toHaveLength(0);
  });
});

describe("the config that grants the permission", () => {
  it("treats a whitelist written before this release as read-only", async () => {
    // The compatibility promise: upgrading JAM must not widen what an agent
    // may change.
    const config = ProjectConfigSchema.parse({
      customFields: [{ id: "customfield_10100", name: "Notes" }],
    });

    expect(config.customFields[0]!.writable).toBe(false);
  });

  it("accepts an explicit opt-in", () => {
    const config = ProjectConfigSchema.parse({
      customFields: [{ id: "customfield_10100", name: "Notes", writable: true }],
    });

    expect(config.customFields[0]!.writable).toBe(true);
  });

  it("refuses a whitelist that names one field twice", () => {
    // A selector has to name one field. Two rows sharing an id would make
    // which one is written a matter of ordering.
    expect(() =>
      ProjectConfigSchema.parse({
        customFields: [
          { id: "customfield_10100", name: "Notes" },
          { id: "customfield_10100", name: "Also Notes" },
        ],
      }),
    ).toThrow(/duplicate custom field id/);
  });

  it("refuses two writable fields sharing a name", () => {
    expect(() =>
      ProjectConfigSchema.parse({
        customFields: [
          { id: "customfield_10100", name: "Notes", writable: true },
          { id: "customfield_10200", name: "notes", writable: true },
        ],
      }),
    ).toThrow(/duplicate custom field writable name/);
  });

  it("allows a read-only field to share a name with a writable one", () => {
    // Only writable entries are ever resolved against, so a read-only
    // namesake cannot make a write ambiguous.
    expect(() =>
      ProjectConfigSchema.parse({
        customFields: [
          { id: "customfield_10100", name: "Notes", writable: true },
          { id: "customfield_10200", name: "Notes" },
        ],
      }),
    ).not.toThrow();
  });

  it("refuses something that is not a Jira custom field id", () => {
    expect(() =>
      ProjectConfigSchema.parse({ customFields: [{ id: "summary", name: "Summary" }] }),
    ).toThrow();
  });
});
