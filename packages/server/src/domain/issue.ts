/**
 * A reference to a Jira issue.
 *
 * `key` is what a person types, a branch name carries and an integration links
 * on - and it is not an identity. Jira mints keys per project and a key can be
 * moved between issues, so the same string can name a different issue later.
 * `issueId` is the identity: the immutable id Jira assigns once and never
 * reuses.
 *
 * `issueId` is optional because JAM will not invent one. Jira supplies it on
 * every issue resource and on the nested references it embeds, but a payload
 * that omits it leaves the field absent rather than empty - "not returned" and
 * "returned blank" are different facts, and only one of them is true.
 */
export type IssueRef = {
  key: string;
  issueId?: string;
  summary?: string;
  status?: string;
  /** See IssueSummary.statusCategory. */
  statusCategory?: string;
};

/**
 * SEARCH level. Deliberately excludes description/comments/attachments/changelog
 * so discovery stays cheap.
 */
export type IssueSummary = {
  key: string;
  /** Jira's immutable issue id. See IssueRef. */
  issueId?: string;
  summary: string;
  status: string;
  /**
   * Jira's own machine-readable status category key, as Jira publishes it -
   * currently `new`, `indeterminate` or `done`, plus `undefined` for a status
   * in no category.
   *
   * Passed through, never derived. `status` is a workflow-defined, localized
   * name: a project can call a category-`done` status "Shipped", "완료" or
   * "Won't Fix", and matching those strings is how an agent decides an issue
   * is finished when it is not. This is the field to read instead, and JAM
   * neither renames Jira's values nor turns them into a verdict of its own.
   *
   * Absent when Jira returned a status without a category. Absent is absent -
   * it is not `new`.
   */
  statusCategory?: string;
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
