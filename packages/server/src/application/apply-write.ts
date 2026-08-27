import type { JamDeps } from "../deps.js";
import type { FullIssueContext } from "../domain/context.js";
import { JamError, toJamError } from "../domain/errors.js";
import type {
  CustomFieldKind,
  CustomFieldValueView,
  ExistingIssueWritePlan,
  WriteApplyReceipt,
} from "../domain/write.js";
import { readModeAfterWrite } from "../policy/consistency-policy.js";
import { assertAssignable } from "../policy/assignee-policy.js";
import { assertCustomFieldUnchanged } from "../policy/custom-field-policy.js";
import { assertUnchanged } from "../policy/write-policy.js";
import { applyCreateIssue } from "./apply-create-issue.js";
import { currentCustomFieldView, readIssue } from "./plan-write.js";

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
  assertUnchanged(plan.issueKey, plan.baseUpdated, current.issue.updated);

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
    operation: plan.operation,
    before: plan.before,
    after,
    verified: true,
    ...(outcome.commentId ? { commentId: outcome.commentId } : {}),
  };
}

/**
 * Re-derive the premises the revision check does not cover.
 *
 * Only `assignee.update` has any: the rest are fully described by the issue's
 * own state, which `assertUnchanged` already compared.
 */
async function revalidate(deps: JamDeps, plan: ExistingIssueWritePlan): Promise<void> {
  if (plan.mutation.kind === "assignee") {
    const target = plan.intendedAfter["assignee"] as { accountId: string; displayName: string };
    assertAssignable(
      plan.issueKey,
      target,
      await deps.jiraAssignees.isAssignable(plan.issueKey, plan.mutation.accountId),
    );
    return;
  }

  if (plan.mutation.kind === "custom-field" && plan.customFieldRequirements) {
    // A field can be taken off a screen, lose its `set` operation, change type
    // or have an option renamed without the issue's own revision moving, so
    // `assertUnchanged` cannot see any of it. These are the premises the plan
    // actually rested on, re-derived.
    assertCustomFieldUnchanged(
      plan.issueKey,
      plan.customFieldRequirements,
      await deps.jiraEditMetadata.getEditableFields(plan.issueKey),
    );
  }
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
      case "custom-field":
        // The ordinary issue edit endpoint. A custom field is a field; what
        // made it need its own operation was deciding whether it may be
        // written and in what shape, and that is already settled here.
        await deps.jiraWrite.updateIssue(plan.issueKey, {
          [plan.mutation.fieldId]: plan.mutation.value,
        });
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
  const snapshot = await readIssue(
    deps,
    plan.issueKey,
    plan.mutation.kind === "custom-field" ? [plan.mutation.fieldId] : [],
  );
  const issue = snapshot.issue;

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

  if (plan.mutation.kind === "custom-field" && plan.customFieldRequirements) {
    const requirements = plan.customFieldRequirements;
    const expected = plan.intendedAfter["customField"] as CustomFieldValueView;
    const observedValue = currentCustomFieldView(
      { id: requirements.fieldId, name: requirements.fieldName },
      requirements.kind,
      snapshot.customFieldValues?.[requirements.fieldId],
    );

    if (!sameCustomFieldValue(requirements.kind, expected.value, observedValue.value)) {
      throw verificationFailed(
        plan,
        { customField: expected },
        { customField: observedValue },
      );
    }
    return { customField: observedValue };
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

/**
 * Did the field end up holding what was planned?
 *
 * Options are compared on their ids, never on their labels - an option is
 * identified by its id, and a label is what a person reads. For a multi-select
 * the comparison is set-wise: Jira is free to return the same selection in a
 * different order, and that is not a different selection.
 */
function sameCustomFieldValue(
  kind: CustomFieldKind,
  expected: CustomFieldValueView["value"],
  observed: CustomFieldValueView["value"],
): boolean {
  if (kind === "multi-option") {
    const ids = (v: CustomFieldValueView["value"]) =>
      (Array.isArray(v) ? v.map((o) => o.id) : []).sort();
    const a = ids(expected);
    const b = ids(observed);
    return a.length === b.length && a.every((id, i) => id === b[i]);
  }
  if (kind === "single-option") {
    const id = (v: CustomFieldValueView["value"]) =>
      v && typeof v === "object" && !Array.isArray(v) ? v.id : undefined;
    return id(expected) === id(observed);
  }
  return expected === observed;
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
