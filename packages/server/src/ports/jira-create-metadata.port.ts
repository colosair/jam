import type { CreateFieldMetadata, CreateIssueType } from "../domain/write.js";

/**
 * What Jira will accept when creating an issue in one project, right now.
 *
 * Separate from `JiraWritePort` on purpose. Everything behind that port
 * changes something; nothing behind this one does. Folding schema discovery
 * into the write port would put a read on the far side of a boundary whose
 * whole documented rule is "these calls mutate, and none of them retry" - and
 * the rule is worth more than the one fewer interface.
 *
 * Kept out of `JiraReadPort` too, for the opposite reason: that port answers
 * questions about issues, with completeness semantics attached to every
 * result. This answers a question about a project's configuration, and
 * `meta.complete` would mean nothing here.
 *
 * These calls do not retry. Their answers decide a mutation, and a retried
 * answer is a possibly-stale one - the same argument that keeps
 * `getTransitions` on the non-retrying side.
 */
export interface JiraCreateMetadataPort {
  /** Issue types this account may create in this project. */
  getIssueTypes(projectKey: string): Promise<CreateIssueType[]>;
  /** The create screen's fields for one issue type in one project. */
  getCreateFields(projectKey: string, issueTypeId: string): Promise<CreateFieldMetadata[]>;
}
