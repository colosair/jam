import type { JamDeps } from "../deps.js";
import { nowIso, type CompletenessMeta } from "../domain/completeness.js";
import type { FullIssueContext, IssueContext } from "../domain/context.js";
import { JamError } from "../domain/errors.js";
import { fieldsFor } from "../policy/field-policy.js";
import { applyOutputBudget } from "../policy/output-budget-policy.js";
import { toSummary } from "./search-issues.js";

export type GetIssueContextInput = {
  issueKeys: string[];
};

export type GetIssueContextResult = {
  issues: IssueContext[];
  meta: CompletenessMeta;
};

export const MAX_KEYS_PER_CALL = 100;

/**
 * Readiness path. One batched round trip for every requested key, plus the
 * dependency structure needed to answer "can this start yet".
 */
export async function getIssueContext(
  deps: JamDeps,
  input: GetIssueContextInput,
): Promise<GetIssueContextResult> {
  const started = performance.now();
  const keys = normalizeKeys(input.issueKeys);
  const fields = fieldsFor("context", deps.config);

  const fetched = await deps.jira.getIssues({ keys, fields });
  const budget = applyOutputBudget(fetched.issues, deps.config.output.contextTokens);
  const issues = budget.issues.map(toContext);

  const meta: CompletenessMeta = {
    level: "context",
    complete: budget.complete && fetched.missingKeys.length === 0,
    fetchedAt: nowIso(),
    fieldsLoaded: fields,
    linksComplete: budget.linksComplete,
  };

  const overflow = [...budget.overflow];
  if (fetched.missingKeys.length > 0) {
    meta.missingKeys = fetched.missingKeys;
    meta.reason = "PARTIAL_API_RESPONSE";
    meta.notes = [
      `${fetched.missingKeys.length} issue(s) could not be read - they may not exist or may not be visible to this account.`,
    ];
  }
  if (overflow.length > 0) {
    meta.overflow = overflow;
    meta.reason ??= "OUTPUT_BUDGET";
    meta.notes = [
      ...(meta.notes ?? []),
      `Dropped ${overflow.join(", ")} to stay within the ${deps.config.output.contextTokens}-token context budget. Request fewer keys for the full picture.`,
    ];
  }

  deps.telemetry.recordTool({
    tool: "jira_context",
    durationMs: performance.now() - started,
    jiraRequests: Math.ceil(keys.length / MAX_KEYS_PER_CALL) || 1,
    issues: issues.length,
    responseBytes: fetched.responseBytes,
    complete: meta.complete,
  });

  return { issues, meta };
}

/** CONTEXT projection: everything but description/comments/history. */
export function toContext(issue: FullIssueContext): IssueContext {
  const context: IssueContext = {
    ...toSummary(issue),
    subtasks: issue.subtasks,
    links: issue.links,
    customFields: issue.customFields,
  };
  if (issue.issueType) context.issueType = issue.issueType;
  if (issue.parent) context.parent = issue.parent;
  return context;
}

export function normalizeKeys(raw: string[]): string[] {
  const keys = [...new Set(raw.map((k) => k.trim().toUpperCase()).filter(Boolean))];
  if (keys.length === 0) {
    throw new JamError("CONFIG_INVALID", "issueKeys must contain at least one issue key.");
  }
  if (keys.length > MAX_KEYS_PER_CALL * 5) {
    throw new JamError(
      "CONTEXT_TOO_LARGE",
      `Too many issue keys in one call (${keys.length}). Split the request.`,
    );
  }
  const malformed = keys.filter((k) => !/^[A-Z][A-Z0-9_]*-\d+$/.test(k));
  if (malformed.length > 0) {
    throw new JamError(
      "CONFIG_INVALID",
      `Not valid Jira issue keys: ${malformed.join(", ")}`,
      { malformed },
    );
  }
  return keys;
}
