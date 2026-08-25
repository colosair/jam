import type { ProjectConfig } from "../config/schema.js";

export type SearchScope = "preview" | "complete";

export type PaginationPlan = {
  pageSize: number;
  /** Hard stop. Reaching it is reported via completeness metadata, never silently. */
  maxPages: number;
};

/**
 * Pagination is JAM's responsibility, not the agent's.
 *
 * `preview` returns the first page for interactive exploration.
 * `complete` follows nextPageToken to the end, so a page-sized result is never
 * mistaken for the full result set.
 */
export function paginationFor(scope: SearchScope, config: ProjectConfig): PaginationPlan {
  return {
    pageSize: config.search.pageSize,
    maxPages: scope === "preview" ? 1 : config.search.maxPages,
  };
}
