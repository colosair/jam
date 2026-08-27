import type { AssigneeCandidate } from "../domain/write.js";

/**
 * Who Jira thinks a name refers to, and whether they can hold this issue.
 *
 * A third read-shaped port, for the same reason `JiraCreateMetadataPort` is
 * one: nothing here mutates, so it does not belong behind the write port's
 * no-retry contract, and it answers a question about a directory rather than
 * about an issue, so the read port's completeness semantics would mean nothing
 * for it.
 *
 * The two calls are deliberately separate questions. Searching answers "who
 * did the caller mean", and it is allowed to be fuzzy - Jira matches on
 * substrings, and a partial match is a suggestion to show a human. Checking
 * assignability answers "may this exact person hold this exact issue", and it
 * is not fuzzy at all: it takes an accountId that resolution has already
 * settled on. Collapsing them would let a substring match decide a mutation.
 *
 * Neither call retries. Their answers decide a mutation, and a retried answer
 * is a possibly-stale one - the same argument that keeps `getTransitions` and
 * the create metadata calls on the non-retrying side.
 */
export interface JiraAssigneeResolutionPort {
  /**
   * Users matching a query, as Jira's own directory reports them.
   *
   * Fuzzy by nature. What comes back is candidates, never a decision - see
   * `resolveAssignee` for what JAM will and will not do with them.
   */
  searchUsers(query: string): Promise<AssigneeCandidate[]>;

  /**
   * Whether this exact account may be assigned this exact issue, right now.
   *
   * Asked by accountId, so it is an identity question rather than a name one.
   * Asked again immediately before the write, because a permission that held
   * when the plan was made is not the same as one that still holds.
   */
  isAssignable(issueKey: string, accountId: string): Promise<boolean>;
}
