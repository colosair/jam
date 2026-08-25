import { describe, expect, it } from "vitest";
import { mapIssueWithMeta, normalizeFieldValue } from "../../src/adapters/jira-cloud/mapper.js";
import { testConfig } from "../helpers.js";

const config = testConfig({ customFields: [{ id: "customfield_10011", name: "Sprint" }] });

describe("mapIssue", () => {
  it("maps lite fields and collapses Jira's wrappers", () => {
    const { issue } = mapIssueWithMeta(
      {
        key: "PROJECT-101",
        fields: {
          summary: "Example",
          status: { name: "In Progress" },
          assignee: { displayName: "CURRENT_USER" },
          priority: { name: "High" },
          updated: "2026-08-25T12:00:00.000+0900",
          labels: ["front"],
          components: [{ name: "web" }],
          issuetype: { name: "Task" },
        },
      },
      config,
    );

    expect(issue).toMatchObject({
      key: "PROJECT-101",
      summary: "Example",
      status: "In Progress",
      assignee: "CURRENT_USER",
      priority: "High",
      labels: ["front"],
      components: ["web"],
      issueType: "Task",
    });
  });

  it("flags inward 'is blocked by' links as blocking this issue", () => {
    const { issue } = mapIssueWithMeta(
      {
        key: "PROJECT-101",
        fields: {
          issuelinks: [
            {
              type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
              inwardIssue: { key: "PROJECT-97", fields: { summary: "API contract", status: { name: "Open" } } },
            },
            {
              type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
              outwardIssue: { key: "PROJECT-120", fields: { summary: "UI work" } },
            },
          ],
        },
      },
      config,
    );

    expect(issue.links).toEqual([
      {
        type: "is blocked by",
        direction: "inward",
        issue: { key: "PROJECT-97", summary: "API contract", status: "Open" },
        blocksThisIssue: true,
      },
      {
        type: "blocks",
        direction: "outward",
        issue: { key: "PROJECT-120", summary: "UI work" },
        blocksThisIssue: false,
      },
    ]);
  });

  it("normalizes description ADF to text and reports the true comment total", () => {
    const { issue, commentTotal } = mapIssueWithMeta(
      {
        key: "PROJECT-97",
        fields: {
          description: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Agreed on v2." }] }],
          },
          comment: {
            total: 12,
            comments: [
              {
                id: "1",
                author: { displayName: "reviewer" },
                created: "2026-08-01T00:00:00.000+0900",
                body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "LGTM" }] }] },
              },
            ],
          },
        },
      },
      config,
    );

    expect(issue.description).toBe("Agreed on v2.");
    expect(issue.comments).toEqual([
      { id: "1", created: "2026-08-01T00:00:00.000+0900", body: "LGTM", author: "reviewer" },
    ]);
    expect(commentTotal).toBe(12);
  });

  it("only surfaces whitelisted custom fields, under their configured name", () => {
    const { issue } = mapIssueWithMeta(
      {
        key: "PROJECT-1",
        fields: {
          customfield_10011: { value: "Sprint 3" },
          customfield_99999: "not whitelisted",
        },
      },
      config,
    );

    expect(issue.customFields).toEqual({ Sprint: "Sprint 3" });
  });
});

describe("normalizeFieldValue", () => {
  it("unwraps options, users and ADF", () => {
    expect(normalizeFieldValue({ value: "Yes" })).toBe("Yes");
    expect(normalizeFieldValue({ displayName: "CURRENT_USER" })).toBe("CURRENT_USER");
    expect(normalizeFieldValue({ name: "Sprint 3" })).toBe("Sprint 3");
    expect(
      normalizeFieldValue({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] }),
    ).toBe("hi");
    expect(normalizeFieldValue([{ value: "a" }, { value: "b" }])).toEqual(["a", "b"]);
    expect(normalizeFieldValue(null)).toBeUndefined();
  });
});
