export type ContextLevel = "search" | "context" | "full";

export type IncompleteReason =
  | "OUTPUT_BUDGET"
  | "PERMISSION"
  | "PARTIAL_API_RESPONSE"
  | "UNKNOWN";

/**
 * Attached to every tool result so the agent can tell a full picture from a
 * partial one. Silent truncation is prohibited: anything dropped must show up
 * here with `complete: false` and a reason.
 */
export type CompletenessMeta = {
  level: ContextLevel;
  complete: boolean;

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

export function nowIso(): string {
  return new Date().toISOString();
}
