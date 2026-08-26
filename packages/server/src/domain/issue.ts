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
  /**
   * True when Jira's issue-link semantics put this issue on the blocked side.
   *
   * A reading of the link, not a verdict on the work: it is derived from how
   * Jira words the relationship, so `true` is not a finding that work cannot
   * start, and `false` is not a finding that nothing blocks it. Whatever is
   * only written in a description, an MR or a spec is not represented here.
   */
  blocksThisIssue: boolean;
};
