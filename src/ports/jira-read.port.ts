import type { FullIssueContext, NormalizedComment } from "../domain/context.js";

/**
 * One page of a JQL search. Pagination itself is NOT the adapter's decision -
 * the adapter fetches exactly one page and reports the continuation token;
 * PaginationPolicy in the application layer decides whether to keep going.
 */
export type SearchPageRequest = {
  jql: string;
  fields: string[];
  pageSize: number;
  pageToken?: string;
};

export type SearchPageResult = {
  /** Partially populated: only the requested fields are set. */
  issues: FullIssueContext[];
  nextPageToken?: string;
  responseBytes: number;
};

export type GetIssuesRequest = {
  keys: string[];
  fields: string[];
};

export type GetIssuesResult = {
  issues: FullIssueContext[];
  /** Keys that were requested but not returned (missing or not permitted). */
  missingKeys: string[];
  /**
   * Total comment count per issue key as Jira reports it. The embedded comment
   * field only carries the first page, so FULL uses this to decide whether more
   * pages must be fetched before the thread can be called complete.
   */
  commentTotals: Record<string, number>;
  responseBytes: number;
};

export type GetCommentsRequest = {
  key: string;
  startAt: number;
  maxResults: number;
};

export type GetCommentsResult = {
  comments: NormalizedComment[];
  startAt: number;
  total: number;
  responseBytes: number;
};

export type CurrentUser = {
  accountId: string;
  displayName?: string;
  emailAddress?: string;
};

export type ProjectRef = {
  key: string;
  name: string;
};

export type ListProjectsResult = {
  projects: ProjectRef[];
  /** True when more projects exist than were returned - advisory only, not paginated. */
  truncated: boolean;
};

export interface JiraReadPort {
  searchPage(req: SearchPageRequest): Promise<SearchPageResult>;
  getIssues(req: GetIssuesRequest): Promise<GetIssuesResult>;
  getComments(req: GetCommentsRequest): Promise<GetCommentsResult>;
  /** Used by `jam doctor` to prove authentication works. */
  getCurrentUser(): Promise<CurrentUser>;
  /**
   * Advisory only - used by `jam setup` to show the operator their options
   * when no project key could be decided safely. Not part of the MCP tool
   * contract and not held to the completeness/pagination guarantees that
   * govern tool results.
   */
  listProjects(): Promise<ListProjectsResult>;
}
