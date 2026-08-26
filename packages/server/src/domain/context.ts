import type { IssueLink, IssueRef, IssueSummary } from "./issue.js";

/** CONTEXT level: enough to judge readiness, blockers, dependencies, priority. */
export type IssueContext = IssueSummary & {
  issueType?: string;
  parent?: IssueRef;
  subtasks: IssueRef[];
  links: IssueLink[];
  customFields: Record<string, unknown>;
};

export type NormalizedComment = {
  id: string;
  author?: string;
  created: string;
  updated?: string;
  body: string;
};

export type RelevantHistory = {
  created: string;
  author?: string;
  field: string;
  from?: string;
  to?: string;
};

/** FULL level: the Jira record for agreement, contract, approval, closure. */
export type FullIssueContext = IssueContext & {
  description?: string;
  comments: NormalizedComment[];
  history?: RelevantHistory[];
  /**
   * The most recent timestamp on any comment retrieved, edits included.
   *
   * A raw fact, not a verdict: how old is too old differs per team, so JAM
   * reports when the thread last moved and leaves "stale" to the caller.
   * Costs no extra Jira call - it is computed from comments already fetched,
   * and is therefore as complete as `commentsComplete` says they are.
   */
  latestCommentAt?: string;
};
