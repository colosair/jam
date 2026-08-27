/**
 * Read-after-write rule.
 *
 * Normal read      -> Enhanced JQL search (`jira_search`)
 * Post-write read  -> direct issue GET for the affected key
 *
 * "Direct issue GET" means `JiraReadPort.getIssue` - one key, one
 * `GET /rest/api/3/issue/{key}`. Not a search, whose index can lag behind the
 * issue it describes, and not `getIssues`: that is a bulk endpoint taking a
 * list, and a bulk read is free to answer from a different path than the
 * single-issue one. The difference is invisible in a listing and decisive in
 * the read that says whether a mutation may proceed, or whether one landed.
 *
 * Every read the write plane makes goes through it: the pre-write conflict
 * check, the post-write confirmation, and the post-create confirmation.
 */
export type ReadMode = "search" | "direct";

export function readModeAfterWrite(): ReadMode {
  return "direct";
}

export function readModeForQuery(): ReadMode {
  return "search";
}
