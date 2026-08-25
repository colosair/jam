import type { JamDeps } from "../deps.js";
import { nowIso, type CompletenessMeta } from "../domain/completeness.js";
import type { FullIssueContext } from "../domain/context.js";
import { fieldsFor } from "../policy/field-policy.js";
import { applyOutputBudget } from "../policy/output-budget-policy.js";
import { normalizeKeys, toContext, MAX_KEYS_PER_CALL } from "./get-issue-context.js";

export type GetFullIssueContextInput = {
  issueKeys: string[];
};

export type GetFullIssueContextResult = {
  issues: FullIssueContext[];
  meta: CompletenessMeta;
};

const COMMENT_PAGE_SIZE = 100;
/** Safety stop for pathological threads; hitting it is reported, never silent. */
const MAX_COMMENT_PAGES = 20;

/**
 * Final-judgement path: description plus the complete comment thread.
 *
 * Comments are the whole point here - an agreement or approval call made on a
 * partial thread is exactly the failure this tool exists to prevent, so the
 * thread is paged to exhaustion and any shortfall is reported.
 */
export async function getFullIssueContext(
  deps: JamDeps,
  input: GetFullIssueContextInput,
): Promise<GetFullIssueContextResult> {
  const started = performance.now();
  const keys = normalizeKeys(input.issueKeys);
  const fields = fieldsFor("full", deps.config);

  const fetched = await deps.jira.getIssues({ keys, fields });
  let jiraRequests = Math.ceil(keys.length / MAX_KEYS_PER_CALL) || 1;
  let responseBytes = fetched.responseBytes;
  const partialThreads: string[] = [];

  for (const issue of fetched.issues) {
    const total = fetched.commentTotals[issue.key] ?? issue.comments.length;
    let pages = 0;
    while (issue.comments.length < total && pages < MAX_COMMENT_PAGES) {
      const page = await deps.jira.getComments({
        key: issue.key,
        startAt: issue.comments.length,
        maxResults: COMMENT_PAGE_SIZE,
      });
      jiraRequests++;
      responseBytes += page.responseBytes;
      pages++;
      if (page.comments.length === 0) break;
      issue.comments.push(...page.comments);
    }
    if (issue.comments.length < total) partialThreads.push(issue.key);
  }

  const budget = applyOutputBudget(fetched.issues, deps.config.output.fullTokens);
  const issues = budget.issues.map((issue) => toFull(issue));

  const commentsComplete = budget.commentsComplete && partialThreads.length === 0;

  const meta: CompletenessMeta = {
    level: "full",
    complete:
      budget.complete && fetched.missingKeys.length === 0 && partialThreads.length === 0,
    fetchedAt: nowIso(),
    fieldsLoaded: fields,
    commentsComplete,
    linksComplete: budget.linksComplete,
  };

  const notes: string[] = [];

  if (fetched.missingKeys.length > 0) {
    meta.missingKeys = fetched.missingKeys;
    meta.reason = "PARTIAL_API_RESPONSE";
    notes.push(
      `${fetched.missingKeys.length} issue(s) could not be read - they may not exist or may not be visible to this account.`,
    );
  }

  if (partialThreads.length > 0) {
    meta.reason ??= "PARTIAL_API_RESPONSE";
    meta.overflow = [...(meta.overflow ?? []), "comments"];
    notes.push(
      `Comment thread not fully retrieved for: ${partialThreads.join(", ")}. Do not treat the discussion as settled.`,
    );
  }

  if (budget.overflow.length > 0) {
    meta.overflow = [...new Set([...(meta.overflow ?? []), ...budget.overflow])];
    meta.reason ??= "OUTPUT_BUDGET";
    notes.push(
      `Dropped ${budget.overflow.join(", ")}${
        budget.droppedComments > 0 ? ` (${budget.droppedComments} oldest comment(s))` : ""
      } to stay within the ${deps.config.output.fullTokens}-token full budget. Request a single issue key for the complete record.`,
    );
  }

  if (notes.length > 0) meta.notes = notes;

  deps.telemetry.recordTool({
    tool: "jira_full",
    durationMs: performance.now() - started,
    jiraRequests,
    issues: issues.length,
    responseBytes,
    complete: meta.complete,
  });

  return { issues, meta };
}

function toFull(issue: FullIssueContext): FullIssueContext {
  const full: FullIssueContext = {
    ...toContext(issue),
    comments: issue.comments,
  };
  if (issue.description) full.description = issue.description;
  if (issue.history?.length) full.history = issue.history;
  return full;
}
