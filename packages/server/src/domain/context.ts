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

/** FULL level: enough to judge agreement, contract, approval, closure. */
export type FullIssueContext = IssueContext & {
  description?: string;
  comments: NormalizedComment[];
  history?: RelevantHistory[];
};
