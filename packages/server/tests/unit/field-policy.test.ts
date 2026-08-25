import { describe, expect, it } from "vitest";
import { fieldsFor, HEAVY_FIELDS } from "../../src/policy/field-policy.js";
import { testConfig } from "../helpers.js";

describe("fieldsFor", () => {
  const config = testConfig({
    customFields: [{ id: "customfield_10011", name: "Sprint" }],
  });

  it("keeps SEARCH lite and free of heavy fields", () => {
    const fields = fieldsFor("search", config);
    expect(fields).toEqual([
      "summary",
      "status",
      "assignee",
      "priority",
      "updated",
      "labels",
      "components",
    ]);
    for (const heavy of HEAVY_FIELDS) expect(fields).not.toContain(heavy);
  });

  it("adds structure and whitelisted custom fields at CONTEXT, still no comments", () => {
    const fields = fieldsFor("context", config);
    expect(fields).toContain("issuelinks");
    expect(fields).toContain("parent");
    expect(fields).toContain("subtasks");
    expect(fields).toContain("customfield_10011");
    expect(fields).not.toContain("comment");
    expect(fields).not.toContain("description");
  });

  it("adds description and comments only at FULL", () => {
    const fields = fieldsFor("full", config);
    expect(fields).toContain("description");
    expect(fields).toContain("comment");
    expect(fields).toContain("issuelinks");
  });

  it("strips heavy fields even when a project config asks for them", () => {
    const sneaky = testConfig({
      fields: { lite: ["summary", "description", "comment"], context: ["changelog", "parent"] },
    });
    expect(fieldsFor("search", sneaky)).toEqual(["summary"]);
    expect(fieldsFor("context", sneaky)).toEqual(["summary", "parent"]);
  });
});
