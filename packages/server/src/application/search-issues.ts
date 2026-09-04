import type { JamDeps } from "../deps.js";
import type { FullIssueContext } from "../domain/context.js";
import { JIRA_EVIDENCE, nowIso, type CompletenessMeta } from "../domain/completeness.js";
import type { IssueSummary } from "../domain/issue.js";
import { fieldsFor } from "../policy/field-policy.js";
import { paginationFor, type SearchScope } from "../policy/pagination-policy.js";
import { estimateTokens } from "../policy/output-budget-policy.js";

export type SearchIssuesInput = {
  jql: string;
  scope?: SearchScope;
};

export type SearchIssuesResult = {
  issues: IssueSummary[];
  meta: CompletenessMeta;
};

/**
 * Discovery path. Lite fields only, pagination owned by JAM.
 *
 * A `complete` search walks nextPageToken to exhaustion; if it hits the page
 * cap it says so instead of presenting a partial list as the whole set.
 */
export async function searchIssues(
  deps: JamDeps,
  input: SearchIssuesInput,
): Promise<SearchIssuesResult> {
  const started = performance.now();
  const scope = input.scope ?? "preview";
  const fields = fieldsFor("search", deps.config);
  const plan = paginationFor(scope, deps.config);

  const collected: FullIssueContext[] = [];
  let pageToken: string | undefined;
  let pagesFetched = 0;
  let responseBytes = 0;
  let truncatedByPageCap = false;

  for (;;) {
    const page = await deps.jira.searchPage({
      jql: input.jql,
      fields,
      pageSize: plan.pageSize,
      ...(pageToken ? { pageToken } : {}),
    });
    pagesFetched++;
    responseBytes += page.responseBytes;
    collected.push(...page.issues);

    pageToken = page.nextPageToken;
    if (!pageToken) break;
    if (pagesFetched >= plan.maxPages) {
      // preview stops here by design; complete hitting the cap is an overflow.
      truncatedByPageCap = scope === "complete";
      break;
    }
  }

  const issues = collected.map(toSummary);
  const morePagesAvailable = Boolean(pageToken);

  const meta: CompletenessMeta = {
    ...JIRA_EVIDENCE,
    level: "search",
    complete: !morePagesAvailable,
    fetchedAt: nowIso(),
    pagesFetched,
    fieldsLoaded: fields,
  };

  if (morePagesAvailable) {
    meta.reason = truncatedByPageCap ? "OUTPUT_BUDGET" : "PARTIAL_API_RESPONSE";
    meta.overflow = ["pages"];
    meta.notes = [
      scope === "preview"
        ? "Preview scope returns the first page only. Re-run with scope=\"complete\" to enumerate every match."
        : `Stopped at the ${plan.maxPages}-page safety cap. Narrow the JQL or raise search.maxPages in project.yaml.`,
    ];
  }

  const budget = deps.config.output.searchTokens;
  const estimated = estimateTokens(issues);
  if (estimated > budget) {
    meta.notes = [
      ...(meta.notes ?? []),
      `Result is larger than the ${budget}-token search budget (~${estimated}). Narrow the JQL.`,
    ];
  }

  deps.telemetry.recordTool({
    tool: "jira_search",
    durationMs: performance.now() - started,
    jiraRequests: pagesFetched,
    issues: issues.length,
    responseBytes,
    pages: pagesFetched,
    complete: meta.complete,
  });

  return { issues, meta };
}

/** Project down to lite fields so heavy data cannot leak through this path. */
export function toSummary(issue: FullIssueContext): IssueSummary {
  // Identity and status semantics ride along at every level, next to the
  // fields they qualify. Both are already in the payload this projection is
  // narrowing, so carrying them costs nothing - and dropping them would make
  // the cheapest read the one an agent cannot safely act on: a key with no
  // identity behind it, and a status name whose meaning it would have to
  // guess. Spread rather than assigned afterwards so the JSON an agent reads
  // puts each beside its subject.
  const summary: IssueSummary = {
    key: issue.key,
    ...(issue.issueId ? { issueId: issue.issueId } : {}),
    summary: issue.summary,
    status: issue.status,
    ...(issue.statusCategory ? { statusCategory: issue.statusCategory } : {}),
    updated: issue.updated,
    labels: issue.labels,
    components: issue.components,
  };
  if (issue.assignee) summary.assignee = issue.assignee;
  if (issue.priority) summary.priority = issue.priority;
  return summary;
}
