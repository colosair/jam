/**
 * Read-after-write rule.
 *
 * JAM is read-only in this release, so nothing enforces this at runtime yet.
 * The rule is fixed here so the write adapter, when it lands, cannot quietly
 * confirm a write with a stale JQL search result.
 *
 * Normal read      -> Enhanced JQL search (`jira_search`)
 * Post-write read  -> direct issue GET for the affected key
 */
export type ReadMode = "search" | "direct";

export function readModeAfterWrite(): ReadMode {
  return "direct";
}

export function readModeForQuery(): ReadMode {
  return "search";
}
