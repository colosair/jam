import type { JamDeps } from "../deps.js";
import type { FullIssueContext } from "../domain/context.js";
import { JamError, toJamError } from "../domain/errors.js";
import type {
  ExistingIssueWritePlan,
  FieldUpdateInput,
  WriteApplyReceipt,
  WriteInput,
  WriteMutation,
} from "../domain/write.js";
import { readModeAfterWrite } from "../policy/consistency-policy.js";
import { assertAssignable } from "../policy/assignee-policy.js";
import { assertSameIssue, assertUnchanged } from "../policy/write-policy.js";
import { applyCreateIssue } from "./apply-create-issue.js";
import { readIssue, toJiraFields, validateInput } from "./plan-write.js";

export type ApplyWriteRequest = { planId: string };

/**
 * Execute a plan JAM made, then go and look at what happened.
 *
 * Three things happen in order, and none of them can be skipped:
 *
 *  1. Re-read the issue and compare its revision to the plan's. A plan that
 *     was valid is not the same as a plan that is still valid.
 *  2. Send the mutation the plan recorded. The caller never supplies it, so
 *     there is no path from "an agent wants to write X" to "JAM writes X"
 *     that does not pass through planning.
 *  3. Read the issue again and check the intended result is actually there.
 *     Jira accepting a request is not evidence that the issue changed - a
 *     transition can be accepted and land somewhere else, a field update can
 *     be silently dropped by a screen configuration.
 *
 * A write that cannot be confirmed is never reported as success. Depending on
 * why, that is JAM_WRITE_VERIFICATION_FAILED (Jira answered, and shows
 * something else) or JAM_WRITE_UNCERTAIN (we do not know whether it landed).
 */
export async function applyWritePlan(
  deps: JamDeps,
  request: ApplyWriteRequest,
): Promise<WriteApplyReceipt> {
  const plan = deps.writePlans.take(request.planId);

  // Post-write reads are direct by policy; so is this pre-write one. Both
  // decide a mutation, and a search result can lag behind the issue it names.
  if (readModeAfterWrite() !== "direct") {
    throw new JamError("CONFIG_INVALID", "Write confirmation must use a direct issue read.");
  }

  // Creation follows the same three steps with a different first one: there is
  // no issue to re-read, so what gets re-checked is the create schema the plan
  // was built on. Both paths still end in a direct read of a real issue.
  if (plan.kind === "create-issue") return applyCreateIssue(deps, plan);

  const current = await readIssue(deps, plan.issueKey);
  // Identity before revision: if the key now names a different issue, its
  // `updated` timestamp is a fact about something nobody planned to change,
  // and comparing it would be answering the wrong question.
  assertSameIssue(plan.issueKey, plan.issueId, current.issueId);
  assertUnchanged(plan.issueKey, plan.baseUpdated, current.issue.updated);

  // The plan came off disk, so derive its mutation again and check it is the
  // one stored. This is after the revision check on purpose: a moved issue is
  // a conflict, not tampering, and saying so in that order keeps the two
  // situations from being reported as each other.
  assertMutationMatchesInput(plan);

  // Whatever the plan depends on that the revision check cannot see, checked
  // again here. For an assignment that is the target's permission to hold this
  // issue: it can be revoked between planning and applying, and a plan that
  // was valid is not the same as a plan that is still valid.
  await revalidate(deps, plan);

  const outcome = await mutate(deps, plan);

  const after = await verify(deps, plan);

  deps.writePlans.consume(plan.planId);

  return {
    status: "applied",
    issue: plan.issueKey,
    issueId: plan.issueId,
    operation: plan.operation,
    before: plan.before,
    after,
    verified: true,
    ...(outcome.commentId ? { commentId: outcome.commentId } : {}),
  };
}

/**
 * Check the stored mutation is the one this plan's input produces.
 *
 * Plans used to live in the process that made them, so what apply sent could
 * only have come from planning. They live in a file now - shared so that a
 * session whose MCP channel died can still apply one from the shell - and a
 * file can be edited.
 *
 * What replaces the in-process guarantee is this: run the same derivation
 * planning ran, on the plan's own input, and refuse if the answer differs.
 * Editing `mutation` alone is caught here. Editing `input` to match means
 * asking JAM to derive that mutation, which is what `jira_write_plan` is - so
 * there is nothing to gain by forging a plan that could not be obtained by
 * asking for one.
 *
 * Nothing has been sent to Jira when this refuses.
 */
function assertMutationMatchesInput(plan: ExistingIssueWritePlan): void {
  let derived: WriteMutation;
  try {
    // Through validateInput first: the whitelist is part of the derivation, so
    // a plan carrying a field JAM does not write is refused here rather than
    // sent. Re-deriving without it would let an edited input past the check
    // planning applied to it.
    const input = validateInput(plan.operation, plan.input);
    derived = deriveMutation(plan, input);
  } catch (err) {
    // A plan whose input no longer derives anything is not a plan. Say that,
    // rather than letting the original refusal read as a fresh request being
    // rejected.
    throw new JamError(
      "JAM_WRITE_PLAN_TAMPERED",
      `This write plan does not describe a change JAM would make for ${plan.issueKey}. Nothing was written - call jira_write_plan again.`,
      { planId: plan.planId, issueKey: plan.issueKey, reason: toJamError(err).code },
    );
  }

  if (JSON.stringify(derived) !== JSON.stringify(plan.mutation)) {
    throw new JamError(
      "JAM_WRITE_PLAN_TAMPERED",
      `This write plan's recorded change does not match what its input produces for ${plan.issueKey}. Nothing was written - call jira_write_plan again.`,
      { planId: plan.planId, issueKey: plan.issueKey },
    );
  }
}

/**
 * The mutation this plan's input produces, without asking Jira anything.
 *
 * Planning calls Jira for two of these - the transition list, the user
 * directory - and records what it settled on. Re-deriving here reads those
 * recorded answers rather than fetching them again, for two reasons: apply
 * would otherwise pay a round trip it does not need, and planning's lookups
 * carry refusals that belong to planning (`already assigned`, `not
 * assignable`). Running those a second time would report a check on the
 * current state as if the plan were malformed.
 *
 * What is being checked is narrower and enough: the mutation must be the one
 * this plan's own parts describe. An edit to `mutation` alone is caught. An
 * edit that also rewrites the input and the recorded resolution is a different
 * plan, obtainable by asking for one - and Jira still has to accept it.
 */
function deriveMutation(plan: ExistingIssueWritePlan, input: WriteInput): WriteMutation {
  switch (plan.operation) {
    case "comment.add":
      return { kind: "comment", text: (input as { text: string }).text };
    case "field.update":
      return { kind: "fields", fields: toJiraFields(input as FieldUpdateInput) };
    case "status.transition": {
      // The id came from Jira at plan time and is recorded; what is verified is
      // that the plan still points at its own resolution.
      const transition = plan.transition;
      if (!transition) throw new JamError("CONFIG_INVALID", "A transition plan must record its transition.");
      return { kind: "transition", transitionId: transition.id };
    }
    case "assignee.update": {
      const target = plan.intendedAfter["assignee"] as { accountId?: string } | undefined;
      if (!target?.accountId) {
        throw new JamError("CONFIG_INVALID", "An assignment plan must record who it resolved to.");
      }
      return { kind: "assignee", accountId: target.accountId };
    }
  }
}

/**
 * Re-derive the premises the revision check does not cover.
 *
 * Only `assignee.update` has any: the rest are fully described by the issue's
 * own state, which `assertUnchanged` already compared.
 */
async function revalidate(deps: JamDeps, plan: ExistingIssueWritePlan): Promise<void> {
  if (plan.mutation.kind !== "assignee") return;

  const target = plan.intendedAfter["assignee"] as { accountId: string; displayName: string };
  assertAssignable(
    plan.issueKey,
    target,
    await deps.jiraAssignees.isAssignable(plan.issueKey, plan.mutation.accountId),
  );
}

/**
 * Send the mutation, once.
 *
 * There is no retry here and there must not be one. A request that fails
 * ambiguously - a timeout, a dropped connection - may already have been
 * applied, and resending it turns one comment into two or replays a
 * transition. So an ambiguous failure is converted into JAM_WRITE_UNCERTAIN
 * and handed back with what to do about it: look, do not retry.
 */
async function mutate(deps: JamDeps, plan: ExistingIssueWritePlan): Promise<{ commentId?: string }> {
  try {
    switch (plan.mutation.kind) {
      case "comment": {
        const { id } = await deps.jiraWrite.addComment(plan.issueKey, plan.mutation.text);
        return { commentId: id };
      }
      case "fields":
        await deps.jiraWrite.updateIssue(plan.issueKey, plan.mutation.fields);
        return {};
      case "transition":
        await deps.jiraWrite.transitionIssue(plan.issueKey, plan.mutation.transitionId);
        return {};
      case "assignee":
        await deps.jiraWrite.assignIssue(plan.issueKey, plan.mutation.accountId);
        return {};
      case "create":
        // Unreachable: a create plan is routed to applyCreateIssue above. The
        // case exists so adding a mutation kind is a compile error here rather
        // than a silent fall-through that writes nothing and reports success.
        throw new JamError(
          "CONFIG_INVALID",
          "A create mutation cannot be applied through the existing-issue path.",
        );
    }
  } catch (err) {
    const jamError = toJamError(err);
    if (!isAmbiguous(jamError)) throw jamError;
    throw new JamError(
      "JAM_WRITE_UNCERTAIN",
      `JAM could not tell whether the ${plan.operation} on ${plan.issueKey} was applied: ${jamError.message} Read the issue to find out - do not retry this write, which could apply it twice.`,
      { issueKey: plan.issueKey, operation: plan.operation, cause: jamError.code },
    );
  }
}

/**
 * A failure that says nothing about whether Jira acted.
 *
 * A 403 or a 400 is a decision Jira made and did not act on. A dropped
 * connection or a 5xx is not: the request may have been processed before the
 * answer went missing.
 */
function isAmbiguous(err: JamError): boolean {
  return err.code === "JIRA_UNAVAILABLE" || err.code === "RATE_LIMITED";
}

/**
 * Confirm by reading, and say what was expected when the reading disagrees.
 *
 * Comments are confirmed by the comment appearing, not by a count: another
 * writer could have added one in between, and a count would accept theirs as
 * ours.
 */
async function verify(deps: JamDeps, plan: ExistingIssueWritePlan): Promise<Record<string, unknown>> {
  const snapshot = await readIssue(deps, plan.issueKey);
  const issue = snapshot.issue;

  // The same identity question again, for the read that produces the evidence.
  // Confirming the intended value on an issue the key has since come to name
  // would be reporting somebody else's state as proof of our write.
  assertSameIssue(plan.issueKey, plan.issueId, snapshot.issueId);

  if (plan.mutation.kind === "assignee") {
    // On the accountId, never on the display name. Two people can share a
    // name, so a name comparison would accept the wrong person's assignment as
    // proof of the right one's - which is the entire reason resolution went to
    // the trouble of producing an identity.
    const expected = plan.intendedAfter["assignee"] as { accountId: string; displayName: string };
    const observed = snapshot.assigneeAccountId
      ? { accountId: snapshot.assigneeAccountId, displayName: issue.assignee ?? "" }
      : null;

    if (snapshot.assigneeAccountId !== expected.accountId) {
      throw verificationFailed(plan, { assignee: expected }, { assignee: observed });
    }
    return { assignee: { accountId: expected.accountId, displayName: issue.assignee ?? expected.displayName } };
  }

  if (plan.mutation.kind === "comment") {
    // Direct issue GET again, not the bulk endpoint: this is post-write
    // confirmation, and ConsistencyPolicy makes no exception for the read that
    // happens to want the comment field.
    const { issue: withComments } = await deps.jira.getIssue({
      key: plan.issueKey,
      fields: ["summary", "status", "comment", "updated"],
    });
    const comments = withComments?.comments ?? [];

    const wanted = plan.mutation.text.trim();
    const found = comments.some((c) => c.body.trim() === wanted);
    if (!found) {
      throw verificationFailed(plan, { commentAdded: wanted }, { comments: comments.length });
    }
    return { comments: comments.length, commentAdded: wanted };
  }

  const observed = observedFor(plan, issue);
  for (const [field, expected] of Object.entries(plan.intendedAfter)) {
    if (!sameValue(observed[field], expected)) {
      throw verificationFailed(plan, plan.intendedAfter, observed);
    }
  }
  return observed;
}

function observedFor(plan: ExistingIssueWritePlan, issue: FullIssueContext): Record<string, unknown> {
  const observed: Record<string, unknown> = {};
  for (const field of Object.keys(plan.intendedAfter)) {
    switch (field) {
      case "status":
        observed[field] = issue.status;
        break;
      case "summary":
        observed[field] = issue.summary;
        break;
      case "priority":
        observed[field] = issue.priority;
        break;
      case "labels":
        observed[field] = issue.labels;
        break;
      case "components":
        observed[field] = issue.components;
        break;
      default:
        observed[field] = undefined;
    }
  }
  return observed;
}

function sameValue(observed: unknown, expected: unknown): boolean {
  if (Array.isArray(expected) || Array.isArray(observed)) {
    const a = Array.isArray(observed) ? [...observed].map(String).sort() : [];
    const b = Array.isArray(expected) ? [...expected].map(String).sort() : [];
    return a.length === b.length && a.every((value, i) => value === b[i]);
  }
  return observed === expected;
}

function verificationFailed(
  plan: ExistingIssueWritePlan,
  expected: Record<string, unknown>,
  observed: Record<string, unknown>,
): JamError {
  return new JamError(
    "JAM_WRITE_VERIFICATION_FAILED",
    `Jira accepted the ${plan.operation} on ${plan.issueKey}, but a direct read does not show the intended result. The issue may have been changed by something else, or a workflow rule may have altered the outcome.`,
    { issueKey: plan.issueKey, operation: plan.operation, expected, observed },
  );
}
