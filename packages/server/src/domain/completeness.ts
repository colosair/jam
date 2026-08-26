export type ContextLevel = "search" | "context" | "full";

export type IncompleteReason =
  | "OUTPUT_BUDGET"
  | "PERMISSION"
  | "PARTIAL_API_RESPONSE"
  | "UNKNOWN";

/**
 * What JAM did not look at.
 *
 * Stable codes, never prose: a consumer has to branch on these, and a
 * sentence that gets reworded silently breaks whoever was matching on it.
 * Every JAM result carries all of them today, because JAM reads Jira and
 * nothing else - they exist so that fact is in the payload rather than only
 * in a tool description nobody re-reads.
 */
export type EvidenceLimitation =
  | "REPOSITORY_NOT_EVALUATED"
  | "EXTERNAL_SOURCES_NOT_EVALUATED"
  | "NON_JIRA_DEPENDENCIES_NOT_EVALUATED";

/**
 * Attached to every tool result so the agent can tell a full picture from a
 * partial one. Silent truncation is prohibited: anything dropped must show up
 * here with `complete: false` and a reason.
 *
 * `complete` is about retrieval and nothing else: JAM finished the Jira read
 * it was asked for with no known loss. It is not a claim that Jira holds the
 * whole story, that the repository agrees, or that the work can start - which
 * is what `evidenceScope` and `limitations` are here to say out loud.
 */
export type CompletenessMeta = {
  level: ContextLevel;
  complete: boolean;

  /** Where this came from. One system today, stated rather than assumed. */
  source: "jira";
  /**
   * Whether Jira itself answered this read, or a cache did. On a cache hit
   * `fetchedAt` keeps the time Jira was read - it must never be rewritten to
   * the time the cache answered, or a stale record would look fresh.
   */
  provenance: "live" | "cache";
  /** What kind of evidence this is. Jira records - not project reality. */
  evidenceScope: "jira-records-only";
  limitations: EvidenceLimitation[];

  /** When this snapshot was read from Jira. */
  fetchedAt: string;

  pagesFetched?: number;
  fieldsLoaded?: string[];

  commentsComplete?: boolean;
  linksComplete?: boolean;

  reason?: IncompleteReason;
  /** Which part of the payload was dropped or could not be read. */
  overflow?: string[];
  /** Issue keys the request asked for but could not be returned. */
  missingKeys?: string[];
  notes?: string[];
};

/**
 * The evidence boundary every JAM result carries.
 *
 * One constant rather than three copies: the day JAM reads something that is
 * not Jira, or serves a read from cache, exactly one of these has to change
 * and the three tools cannot drift apart in the meantime.
 */
export const JIRA_EVIDENCE = {
  source: "jira",
  provenance: "live",
  evidenceScope: "jira-records-only",
  limitations: [
    "REPOSITORY_NOT_EVALUATED",
    "EXTERNAL_SOURCES_NOT_EVALUATED",
    "NON_JIRA_DEPENDENCIES_NOT_EVALUATED",
  ],
} as const satisfies Pick<
  CompletenessMeta,
  "source" | "provenance" | "evidenceScope" | "limitations"
>;

export function nowIso(): string {
  return new Date().toISOString();
}
