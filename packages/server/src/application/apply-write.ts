import type { JamDeps } from "../deps.js";
import type { FullIssueContext } from "../domain/context.js";
import { JamError, toJamError } from "../domain/errors.js";
import type { ExistingIssueWritePlan, WriteApplyReceipt } from "../domain/write.js";
import { readModeAfterWrite } from "../policy/consistency-policy.js";
import { assertUnchanged } from "../policy/write-policy.js";
import { applyCreateIssue } from "./apply-create-issue.js";
import { readIssue } from "./plan-write.js";

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
  assertUnchanged(plan.issueKey, plan.baseUpdated, current.updated);

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
  const issue = await readIssue(deps, plan.issueKey);

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
