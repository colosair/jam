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

export type GetIssueRequest = {
  key: string;
  fields: string[];
};

export type GetIssueResult = {
  /** Absent when Jira has no such issue, or this account cannot see it. */
  issue?: FullIssueContext;
  /**
   * Who the issue is assigned to, by identity rather than by name.
   *
   * Here rather than on the issue because only the write plane needs it. Two
   * people can share a display name, so `assignee` cannot settle whether an
   * assignment landed on the right person - and the read tools have no use for
   * an accountId, so their payload does not grow one.
   *
   * Absent when the issue is unassigned, or when the field was not requested.
   */
  assigneeAccountId?: string;
  responseBytes: number;
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
  /**
   * One issue, read directly by key.
   *
   * Separate from `getIssues` because ConsistencyPolicy requires a direct
   * issue GET for anything that decides or confirms a write, and `getIssues`
   * is not one: it is a bulk endpoint that takes a list, and a bulk read is
   * free to answer from a different path than a single-issue GET. The
   * distinction only matters in one place - the write plane - which is exactly
   * where being wrong about it is most expensive.
   *
   * Reads and writes both use it: the pre-write conflict check, the post-write
   * confirmation, and the post-create confirmation.
   */
  getIssue(req: GetIssueRequest): Promise<GetIssueResult>;
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
