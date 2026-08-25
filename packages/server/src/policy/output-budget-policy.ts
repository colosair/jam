import type { FullIssueContext } from "../domain/context.js";

/**
 * Output budget enforcement.
 *
 * The rule that matters is not "stay small" but "never lie about being small".
 * Anything dropped here is reported through `overflow` so the caller can put it
 * in completeness metadata; silent truncation is a release blocker.
 *
 * Drop order is the inverse of the design's keep-priority:
 *   core metadata > description > links/dependencies > comments > changelog
 */

/** Rough proxy for tokens. Cheap, dependency-free, tuned against real payloads later. */
export function estimateTokens(value: unknown): number {
  if (value === undefined) return 0;
  return Math.ceil(JSON.stringify(value).length / 4);
}

export type BudgetOutcome = {
  issues: FullIssueContext[];
  /** Which parts were dropped, e.g. ["comments", "description"]. */
  overflow: string[];
  complete: boolean;
  commentsComplete: boolean;
  linksComplete: boolean;
  droppedComments: number;
};

export function applyOutputBudget(
  input: FullIssueContext[],
  budgetTokens: number,
): BudgetOutcome {
  const overflow = new Set<string>();
  let droppedComments = 0;

  // Work on copies so callers keep their originals intact.
  const issues = input.map((i) => ({ ...i, comments: [...i.comments] }));

  const stripped = issues.map((i) => bare(i));
  let total = estimateTokens(stripped);

  const historyCost = issues.map((i) => estimateTokens(i.history));
  const descriptionCost = issues.map((i) => estimateTokens(i.description));
  const linkCost = issues.map((i) => estimateTokens(i.links) + estimateTokens(i.subtasks));
  total +=
    sum(historyCost) +
    sum(descriptionCost) +
    sum(linkCost) +
    sum(issues.map((i) => sum(i.comments.map(estimateTokens))));

  const fits = () => total <= budgetTokens;

  // 1. changelog
  if (!fits()) {
    issues.forEach((issue, idx) => {
      if (issue.history?.length) {
        total -= historyCost[idx] ?? 0;
        delete issue.history;
        overflow.add("history");
      }
    });
  }

  // 2. comments - oldest first, so the newest (decision-bearing) ones survive
  if (!fits()) {
    for (const issue of issues) {
      while (issue.comments.length > 0 && !fits()) {
        const oldest = issue.comments.shift()!;
        total -= estimateTokens(oldest);
        droppedComments++;
        overflow.add("comments");
      }
      if (fits()) break;
    }
  }

  // 3. links and subtasks
  if (!fits()) {
    issues.forEach((issue, idx) => {
      if (issue.links.length || issue.subtasks.length) {
        total -= linkCost[idx] ?? 0;
        issue.links = [];
        issue.subtasks = [];
        overflow.add("links");
      }
    });
  }

  // 4. description - last thing to go before core metadata
  if (!fits()) {
    issues.forEach((issue, idx) => {
      if (issue.description) {
        total -= descriptionCost[idx] ?? 0;
        delete issue.description;
        overflow.add("description");
      }
    });
  }

  // Core metadata is never dropped. If it alone exceeds the budget we still
  // return it and report the result as incomplete rather than truncating rows.
  if (!fits()) overflow.add("output_budget_exceeded");

  return {
    issues,
    overflow: [...overflow],
    complete: overflow.size === 0,
    commentsComplete: !overflow.has("comments"),
    linksComplete: !overflow.has("links"),
    droppedComments,
  };
}

function bare(issue: FullIssueContext): Omit<
  FullIssueContext,
  "description" | "comments" | "history" | "links" | "subtasks"
> {
  const { description: _d, comments: _c, history: _h, links: _l, subtasks: _s, ...rest } = issue;
  return rest;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
