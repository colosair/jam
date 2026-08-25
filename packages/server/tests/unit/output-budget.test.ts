import { describe, expect, it } from "vitest";
import { applyOutputBudget, estimateTokens } from "../../src/policy/output-budget-policy.js";
import { issue } from "../helpers.js";

const comment = (id: string, body: string) => ({ id, created: `2026-01-${id.padStart(2, "0")}`, body });

describe("applyOutputBudget", () => {
  it("leaves everything alone when it fits", () => {
    const input = [issue({ key: "PROJECT-1", description: "short", comments: [comment("1", "ok")] })];
    const out = applyOutputBudget(input, 10_000);

    expect(out.complete).toBe(true);
    expect(out.overflow).toEqual([]);
    expect(out.issues[0]?.comments).toHaveLength(1);
    expect(out.issues[0]?.description).toBe("short");
  });

  it("drops the oldest comments first and reports the overflow", () => {
    const input = [
      issue({
        key: "PROJECT-1",
        comments: [
          comment("1", "x".repeat(400)),
          comment("2", "y".repeat(400)),
          comment("3", "latest decision"),
        ],
      }),
    ];
    const out = applyOutputBudget(input, 120);

    expect(out.complete).toBe(false);
    expect(out.overflow).toContain("comments");
    expect(out.commentsComplete).toBe(false);
    expect(out.droppedComments).toBeGreaterThan(0);
    // the newest comment is the one that must survive
    expect(out.issues[0]?.comments.at(-1)?.body).toBe("latest decision");
  });

  it("drops in priority order: history, comments, links, then description", () => {
    const input = [
      issue({
        key: "PROJECT-1",
        description: "d".repeat(2000),
        comments: [comment("1", "c".repeat(2000))],
        links: [
          {
            type: "is blocked by",
            direction: "inward" as const,
            issue: { key: "PROJECT-2" },
            blocksThisIssue: true,
          },
        ],
        history: [{ created: "2026-01-01", field: "status", from: "Open", to: "Done" }],
      }),
    ];
    const out = applyOutputBudget(input, 30);

    expect(out.overflow.slice(0, 4)).toEqual(["history", "comments", "links", "description"]);
    expect(out.issues[0]?.history).toBeUndefined();
    expect(out.issues[0]?.comments).toEqual([]);
    expect(out.issues[0]?.links).toEqual([]);
    expect(out.issues[0]?.description).toBeUndefined();
    // core metadata survives
    expect(out.issues[0]?.key).toBe("PROJECT-1");
    expect(out.issues[0]?.status).toBe("Open");
  });

  it("flags an impossible budget rather than truncating rows", () => {
    const input = [issue({ key: "PROJECT-1" }), issue({ key: "PROJECT-2" })];
    const out = applyOutputBudget(input, 1);

    expect(out.issues).toHaveLength(2);
    expect(out.complete).toBe(false);
    expect(out.overflow).toContain("output_budget_exceeded");
  });

  it("does not mutate the caller's issues", () => {
    const input = [issue({ key: "PROJECT-1", description: "keep", comments: [comment("1", "keep")] })];
    applyOutputBudget(input, 1);

    expect(input[0]?.description).toBe("keep");
    expect(input[0]?.comments).toHaveLength(1);
  });
});

describe("estimateTokens", () => {
  it("scales with payload size", () => {
    expect(estimateTokens("a".repeat(400))).toBeGreaterThan(estimateTokens("a".repeat(40)));
    expect(estimateTokens(undefined)).toBe(0);
  });
});
