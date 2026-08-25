export type IssueRef = {
  key: string;
  summary?: string;
  status?: string;
};

/**
 * SEARCH level. Deliberately excludes description/comments/attachments/changelog
 * so discovery stays cheap.
 */
export type IssueSummary = {
  key: string;
  summary: string;
  status: string;
  assignee?: string;
  priority?: string;
  updated: string;
  labels: string[];
  components: string[];
};

export type LinkDirection = "outward" | "inward";

export type IssueLink = {
  /** Human-readable relationship as Jira words it, e.g. "blocks", "is blocked by". */
  type: string;
  direction: LinkDirection;
  issue: IssueRef;
  /** True when this link means the current issue cannot start yet. */
  blocksThisIssue: boolean;
};
