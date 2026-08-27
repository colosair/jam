import { JamError } from "../domain/errors.js";
import type { AssigneeCandidate, AssigneeRef } from "../domain/write.js";

/**
 * Turning a name into a person, without ever guessing which person.
 *
 * Jira's user search is a substring search: "min" finds Min Kim and Minho
 * Park, and it returns them in whatever order it likes. An agent handing JAM a
 * name is describing an intent, not identifying an account - so the search is
 * how candidates are found, and never how one of them is chosen.
 *
 * The rule is that JAM assigns only when the answer is unambiguous on its own
 * terms: one exact identity. Everything else comes back as a refusal carrying
 * the candidates, so the next move is to name one of them precisely rather
 * than to hope the same query resolves differently.
 *
 * This costs an agent a round trip on ambiguity. The alternative costs someone
 * an issue assigned to the wrong colleague, discovered later.
 */

/**
 * Which candidate the caller meant, if exactly one is certain.
 *
 * In order:
 *
 *  1. An exact accountId. The caller already had an identity; nothing to guess.
 *  2. Exactly one candidate whose display name matches exactly, ignoring case
 *     and surrounding space. "task" and "Task" are the same intent, and an
 *     agent cannot learn a directory's casing before asking.
 *
 * Nothing else resolves. A single substring hit is still a substring hit: it
 * is Jira saying "this contains what you typed", not "this is who you meant".
 */
export function resolveAssignee(
  requested: string,
  candidates: AssigneeCandidate[],
): AssigneeRef {
  const wanted = requested.trim();
  if (wanted.length === 0) {
    throw new JamError(
      "JAM_WRITE_OPERATION_NOT_ALLOWED",
      "assignee.update needs a non-empty `input.assignee`.",
      { operation: "assignee.update" },
    );
  }

  const exact = exactMatches(wanted, candidates);

  if (exact.length === 0) {
    throw new JamError(
      "JAM_WRITE_ASSIGNEE_NOT_FOUND",
      candidates.length === 0
        ? `Jira has no user matching "${requested}".`
        : `No Jira user is exactly "${requested}". JAM assigns only on an exact display name or an accountId, because a partial match is Jira reporting a similarity rather than identifying a person. Name one of the candidates exactly, or pass their accountId.`,
      { requested, candidates: describe(candidates) },
    );
  }

  if (exact.length > 1) {
    // Two people really can share a display name. Picking either would be a
    // coin toss whose result is somebody's issue.
    throw new JamError(
      "JAM_WRITE_ASSIGNEE_AMBIGUOUS",
      `"${requested}" matches ${exact.length} Jira users exactly. Pass the accountId of the one you mean.`,
      { requested, candidates: describe(exact) },
    );
  }

  const match = exact[0]!;

  if (!match.active) {
    throw new JamError(
      "JAM_WRITE_ASSIGNEE_NOT_ASSIGNABLE",
      `${match.displayName} is a deactivated Jira account, so this issue cannot be assigned to them.`,
      { requested, accountId: match.accountId, reason: "INACTIVE" },
    );
  }

  return { accountId: match.accountId, displayName: match.displayName };
}

/**
 * Refuse an assignment Jira would not permit, before asking it to.
 *
 * Assignability is a permission question with a per-project answer, and JAM
 * does not model Jira's permission scheme - it asks. Called at plan time so a
 * refusal is a JAM decision rather than a 400, and again immediately before
 * the write, because a permission that held when the plan was made is not the
 * same as one that still holds.
 */
export function assertAssignable(issueKey: string, target: AssigneeRef, assignable: boolean): void {
  if (assignable) return;
  throw new JamError(
    "JAM_WRITE_ASSIGNEE_NOT_ASSIGNABLE",
    `Jira does not offer ${target.displayName} as an assignee for ${issueKey}. They may lack the assignable-user permission in this project, or have lost it since this plan was made.`,
    { issueKey, accountId: target.accountId, displayName: target.displayName },
  );
}

/**
 * Refuse an assignment that would change nothing.
 *
 * Not an error in Jira's eyes, and not harmful - but a write JAM reports as
 * applied should be a write that happened. Saying so plainly is more useful
 * than a receipt claiming to have changed something that already was.
 */
export function assertNotAlreadyAssigned(
  issueKey: string,
  current: string | undefined,
  target: AssigneeRef,
): void {
  if (current !== target.accountId) return;
  throw new JamError(
    "JAM_WRITE_ASSIGNEE_ALREADY_SET",
    `${issueKey} is already assigned to ${target.displayName}. Nothing to change.`,
    { issueKey, accountId: target.accountId, displayName: target.displayName },
  );
}

/**
 * The candidates this string identifies exactly, if any.
 *
 * Exported so the caller can tell "the search settled it" from "the search did
 * not" without reimplementing the rule - a second copy of what counts as exact
 * is a second answer waiting to disagree with this one.
 *
 * An accountId match wins outright: it is an identity, and a display name that
 * happens to equal somebody's account id is not a reason to consider them.
 */
export function exactMatches(
  requested: string,
  candidates: AssigneeCandidate[],
): AssigneeCandidate[] {
  const wanted = requested.trim();
  const byAccountId = candidates.filter((c) => c.accountId === wanted);
  if (byAccountId.length > 0) return byAccountId;

  return candidates.filter((c) => c.displayName.trim().toLowerCase() === wanted.toLowerCase());
}

/** Candidates as an agent can act on them: a name to repeat, and an id to be sure. */
function describe(candidates: AssigneeCandidate[]): AssigneeCandidate[] {
  return candidates.map((c) => ({
    accountId: c.accountId,
    displayName: c.displayName,
    active: c.active,
  }));
}
