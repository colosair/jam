import { describe, expect, it } from "vitest";
import { adfToText } from "../../src/adapters/jira-cloud/adf-to-text.js";

describe("adfToText", () => {
  it("flattens paragraphs and marks", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Ship " },
            { type: "text", text: "now", marks: [{ type: "strong" }] },
            { type: "text", text: " see ", marks: [] },
            {
              type: "text",
              text: "spec",
              marks: [{ type: "link", attrs: { href: "https://x.example/spec" } }],
            },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe("Ship **now** see [spec](https://x.example/spec)");
  });

  it("renders headings, lists and code blocks", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Plan" }] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
          ],
        },
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const a = 1;" }],
        },
      ],
    };
    expect(adfToText(doc)).toBe("## Plan\n\n- one\n- two\n\n```ts\nconst a = 1;\n```");
  });

  it("renders mentions without doubling the @ prefix, and renders tables", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { text: "@minyong" } },
            { type: "text", text: " please review" },
          ],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Field" }] }] },
                { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Type" }] }] },
              ],
            },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe("@minyong please review\n\n| Field | Type |");
  });

  it("marks unknown nodes instead of dropping them silently", () => {
    const doc = { type: "doc", content: [{ type: "someFutureNode", attrs: {} }] };
    expect(adfToText(doc)).toBe("[unsupported: someFutureNode]");
  });

  it("handles null and plain strings", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText("already text")).toBe("already text");
  });
});
