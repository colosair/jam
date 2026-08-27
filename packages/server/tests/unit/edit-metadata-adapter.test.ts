import { describe, expect, it } from "vitest";
import { JiraCloudEditMetadataAdapter } from "../../src/adapters/jira-cloud/jira-edit-metadata.adapter.js";
import { JamError } from "../../src/domain/errors.js";
import { FakeCredentials } from "../helpers.js";

/**
 * The edit-metadata boundary.
 *
 * The fixtures here are the shapes a real Jira Cloud site returned for a real
 * project - a multi-checkbox with one option, a date picker, a team field, a
 * lexorank - rather than shapes recalled from documentation. What is pinned is
 * the request, and that anything JAM cannot read is dropped instead of
 * half-understood: a field that survives with the wrong shape is a field JAM
 * would claim to understand well enough to write.
 */

type Call = { url: string; method: string };

function recorder(body: unknown, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const adapter = (fetchImpl: typeof fetch) =>
  new JiraCloudEditMetadataAdapter(new FakeCredentials(), fetchImpl);

describe("JiraCloudEditMetadataAdapter", () => {
  it("GETs this issue's editmeta", async () => {
    const { calls, fetchImpl } = recorder({ fields: {} });

    await adapter(fetchImpl).getEditableFields("PROJECT-1");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://example.atlassian.net/rest/api/3/issue/PROJECT-1/editmeta");
  });

  it("encodes a key that needs it", async () => {
    const { calls, fetchImpl } = recorder({ fields: {} });

    await adapter(fetchImpl).getEditableFields("PROJECT 1/2");

    expect(calls[0]!.url).toContain("PROJECT%201%2F2/editmeta");
  });

  it("maps a multi-checkbox as Jira actually returns one", async () => {
    const { fetchImpl } = recorder({
      fields: {
        customfield_10021: {
          required: false,
          schema: {
            type: "array",
            items: "option",
            custom: "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes",
            customId: 10021,
          },
          name: "Flagged",
          operations: ["add", "set", "remove"],
          allowedValues: [{ self: "https://…", value: "Impediment", id: "10019" }],
        },
      },
    });

    expect(await adapter(fetchImpl).getEditableFields("PROJECT-1")).toEqual([
      {
        id: "customfield_10021",
        name: "Flagged",
        required: false,
        operations: ["add", "set", "remove"],
        schema: {
          type: "array",
          items: "option",
          custom: "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes",
          customId: 10021,
        },
        allowedValues: [{ id: "10019", label: "Impediment" }],
      },
    ]);
  });

  it("maps the types JAM refuses, so the refusal can name them", async () => {
    const { fetchImpl } = recorder({
      fields: {
        customfield_10015: {
          schema: { type: "date", custom: "…:datepicker" },
          name: "시작 날짜",
          operations: ["set"],
        },
        customfield_10019: {
          schema: { type: "any", custom: "com.pyxis.greenhopper.jira:gh-lexo-rank" },
          name: "순위",
          operations: ["set"],
        },
      },
    });

    const fields = await adapter(fetchImpl).getEditableFields("PROJECT-1");

    expect(fields.map((f) => f.schema.type).sort()).toEqual(["any", "date"]);
  });

  it("reads an option label from `name` where Jira uses that instead of `value`", async () => {
    const { fetchImpl } = recorder({
      fields: {
        customfield_10200: {
          schema: { type: "option" },
          name: "Category",
          operations: ["set"],
          allowedValues: [
            { id: "1", value: "By value" },
            { id: 2, name: "By name" },
          ],
        },
      },
    });

    const [field] = await adapter(fetchImpl).getEditableFields("PROJECT-1");

    expect(field?.allowedValues).toEqual([
      { id: "1", label: "By value" },
      { id: "2", label: "By name" },
    ]);
  });

  it("handles an option label that is not ASCII", async () => {
    const { fetchImpl } = recorder({
      fields: {
        customfield_10200: {
          schema: { type: "option" },
          name: "분류",
          operations: ["set"],
          allowedValues: [{ id: "1", value: "백엔드" }],
        },
      },
    });

    const [field] = await adapter(fetchImpl).getEditableFields("PROJECT-1");

    expect(field).toMatchObject({ name: "분류", allowedValues: [{ id: "1", label: "백엔드" }] });
  });

  it("keeps an unconstrained field apart from one constrained to nothing", async () => {
    const { fetchImpl } = recorder({
      fields: {
        customfield_10100: { schema: { type: "string" }, name: "Notes", operations: ["set"] },
        customfield_10047: {
          schema: { type: "array", items: "goal" },
          name: "목표",
          operations: ["set"],
          allowedValues: [],
        },
      },
    });

    const fields = await adapter(fetchImpl).getEditableFields("PROJECT-1");
    const notes = fields.find((f) => f.id === "customfield_10100");
    const goals = fields.find((f) => f.id === "customfield_10047");

    expect(notes).not.toHaveProperty("allowedValues");
    expect(goals?.allowedValues).toEqual([]);
  });

  it("drops a field with no schema type, which it could not classify", async () => {
    const { fetchImpl } = recorder({
      fields: {
        customfield_10100: { name: "Shapeless", operations: ["set"] },
        customfield_10200: { schema: { type: "string" }, name: "Notes", operations: ["set"] },
      },
    });

    expect((await adapter(fetchImpl).getEditableFields("PROJECT-1")).map((f) => f.id)).toEqual([
      "customfield_10200",
    ]);
  });

  it("drops an option that can be neither chosen nor recognised", async () => {
    const { fetchImpl } = recorder({
      fields: {
        customfield_10200: {
          schema: { type: "option" },
          name: "Category",
          operations: ["set"],
          allowedValues: [{ id: "1" }, { value: "No id" }, { id: "2", value: "Fine" }],
        },
      },
    });

    const [field] = await adapter(fetchImpl).getEditableFields("PROJECT-1");

    expect(field?.allowedValues).toEqual([{ id: "2", label: "Fine" }]);
  });

  it("treats a field with no operations as having none, not as unrestricted", async () => {
    const { fetchImpl } = recorder({
      fields: { customfield_10100: { schema: { type: "string" }, name: "Notes" } },
    });

    const [field] = await adapter(fetchImpl).getEditableFields("PROJECT-1");

    expect(field?.operations).toEqual([]);
  });

  it("treats a response with no fields as no editable fields", async () => {
    const { fetchImpl } = recorder({});

    expect(await adapter(fetchImpl).getEditableFields("PROJECT-1")).toEqual([]);
  });

  it("surfaces a permission failure rather than reporting nothing editable", async () => {
    // "You may not see this issue" and "this issue has no editable fields"
    // are different answers, and only one of them is JAM's to act on.
    const { fetchImpl } = recorder({ errorMessages: ["no permission"] }, 403);

    await expect(adapter(fetchImpl).getEditableFields("PROJECT-1")).rejects.toBeInstanceOf(JamError);
  });

  it("surfaces a missing issue", async () => {
    const { fetchImpl } = recorder({ errorMessages: ["does not exist"] }, 404);

    await expect(adapter(fetchImpl).getEditableFields("PROJECT-9")).rejects.toMatchObject({
      code: "ISSUE_NOT_FOUND",
    });
  });

  it("does not retry, because its answer decides a mutation", async () => {
    const { calls, fetchImpl } = recorder({ message: "unavailable" }, 503);

    await expect(adapter(fetchImpl).getEditableFields("PROJECT-1")).rejects.toBeInstanceOf(JamError);

    expect(calls).toHaveLength(1);
  });
});
