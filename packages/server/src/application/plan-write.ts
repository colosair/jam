import type { JamDeps } from "../deps.js";
import type { FullIssueContext } from "../domain/context.js";
import { JamError } from "../domain/errors.js";
import type {
  AssigneeUpdateInput,
  CommentAddInput,
  ExistingIssueOperation,
  ExistingIssueWritePlan,
  FieldUpdateInput,
  StatusTransitionInput,
  WriteInput,
  WriteMutation,
  WritePlan,
  WritePlanReceipt,
} from "../domain/write.js";
import {
  assertExistingIssueOperation,
  assertFieldsAllowed,
  assertOperationAllowed,
  assertWriteScope,
  PLAN_TTL_MS,
  resolveTransition,
} from "../policy/write-policy.js";
import {
  assertAssignable,
  assertNotAlreadyAssigned,
  resolveAssignee,
} from "../policy/assignee-policy.js";
import { planCreateIssue } from "./plan-create-issue.js";

export type PlanWriteRequest = {
  /** Absent for `issue.create`, which names a project rather than an issue. */
  key?: string;
  operation: string;
  input: Record<string, unknown>;
};

/**
 * Work out whether a requested change is currently possible, and describe it.
 *
 * Reads only. Nothing here mutates Jira, and that is the whole point of the
 * step: the agent gets to see what the issue looks like now, what JAM would
 * do to it, and what a direct read will have to show before JAM will call it
 * done - all before anything has happened.
 *
 * The order matters. Scope and operation are checked before any Jira call, so
 * an out-of-scope key costs nothing and comes back as a JAM refusal rather
 * than a 404. Everything after that is derived from the issue as Jira reports
 * it right now, never from what the caller asserted about it.
 */
export async function planWrite(
  deps: JamDeps,
  request: PlanWriteRequest,
): Promise<{ plan: WritePlan; receipt: WritePlanReceipt }> {
  // Creation branches before anything else touches `key`, because it has none.
  // Routing on the operation rather than on whether a key happened to be
  // supplied keeps the two request shapes genuinely separate instead of one
  // shape with holes in it.
  if (assertOperationAllowed(request.operation) === "issue.create") {
    return planCreateIssue(deps, { input: request.input });
  }

  const issueKey = requireIssueKey(request);
  const projectKey = assertWriteScope(issueKey, deps.config.project.key);
  const operation = assertExistingIssueOperation(request.operation);

  // Everything that can be refused from the request alone is refused here,
  // before a Jira call is spent on it. An agent asking to write a field JAM
  // does not write should get that answer, not a round trip and then that
  // answer.
  const input = validateInput(operation, request.input);

  const snapshot = await readIssue(deps, issueKey);
  const issue = snapshot.issue;

  const { before, intendedAfter, mutation, transition, baseAssigneeAccountId } = await describe(
    deps,
    operation,
    issueKey,
    snapshot,
    input,
  );

  const createdAt = new Date();
  const plan = deps.writePlans.create({
    kind: "existing-issue",
    issueKey,
    projectKey,
    operation,
    before,
    intendedAfter,
    baseUpdated: issue.updated,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + PLAN_TTL_MS).toISOString(),
    ...(transition ? { transition } : {}),
    ...(baseAssigneeAccountId ? { baseAssigneeAccountId } : {}),
    mutation,
  }) as ExistingIssueWritePlan;

  return {
    plan,
    receipt: {
      status: "planned",
      planId: plan.planId,
      issue: plan.issueKey,
      operation: plan.operation,
      before: plan.before,
      intendedAfter: plan.intendedAfter,
      expiresAt: plan.expiresAt,
      verification: { method: "direct-issue-read", expects: plan.intendedAfter },
    },
  };
}

/**
 * The issue as Jira has it, read directly by key.
 *
 * `getIssue`, not `getIssues`: ConsistencyPolicy requires a direct issue GET
 * for anything that decides or confirms a write, and the bulk endpoint is not
 * one. A JQL result can lag behind the issue it describes; a bulk fetch is
 * free to answer from a different path than the single-issue endpoint. Neither
 * difference matters for ordinary reads, and both matter here.
 *
 * The one read every write goes through - the pre-write conflict check, the
 * post-write confirmation, and the post-create confirmation.
 */
export type IssueSnapshot = {
  issue: FullIssueContext;
  /** Identity of the current assignee, which `issue.assignee` cannot supply. */
  assigneeAccountId?: string;
};

export async function readIssue(deps: JamDeps, issueKey: string): Promise<IssueSnapshot> {
  const { issue: found, assigneeAccountId } = await deps.jira.getIssue({
    key: issueKey,
    // `issuetype` and `description` are here for creation's verification step,
    // which has to confirm the issue Jira made is the one that was asked for.
    // A field a plan promises to check has to be a field this read returns -
    // otherwise the check silently passes on `undefined`. They cost nothing on
    // the other operations, which do not compare them.
    fields: [
      "summary",
      "status",
      "issuetype",
      "description",
      "assignee",
      "priority",
      "labels",
      "components",
      "updated",
    ],
  });

  if (!found) {
    throw new JamError(
      "ISSUE_NOT_FOUND",
      `Jira has no issue ${issueKey}, or it is not visible to this account.`,
      { issueKey },
    );
  }
  return { issue: found, ...(assigneeAccountId ? { assigneeAccountId } : {}) };
}

/**
 * The issue an existing-issue operation names, or a refusal that says why.
 *
 * `key` is optional on the request only because `issue.create` has no issue.
 * Reaching here means the operation does have one, so its absence is the
 * caller using the wrong shape - which is worth saying, rather than reading as
 * an empty key and failing further in.
 */
function requireIssueKey(request: PlanWriteRequest): string {
  const key = request.key?.trim();
  if (!key) {
    throw new JamError(
      "JAM_WRITE_OPERATION_NOT_ALLOWED",
      `${request.operation} changes an issue that already exists, so it needs \`key\`.`,
      { operation: request.operation },
    );
  }
  return key.toUpperCase();
}

/**
 * Check the request against the contract, and normalize it.
 *
 * Pure: no Jira, no state. Whether an operation is supported, whether a field
 * is writable and whether the input is even the right shape are all knowable
 * without asking Jira anything, so they are answered first.
 */
function validateInput(operation: ExistingIssueOperation, raw: Record<string, unknown>): WriteInput {
  switch (operation) {
    case "comment.add": {
      const text = (raw as CommentAddInput).text;
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new JamError(
          "JAM_WRITE_OPERATION_NOT_ALLOWED",
          "comment.add needs non-empty `input.text`.",
          { operation },
        );
      }
      return { text: text.trim() };
    }
    case "field.update":
      return assertFieldsAllowed(raw as FieldUpdateInput);
    case "status.transition": {
      const status = (raw as StatusTransitionInput).status;
      if (typeof status !== "string" || status.trim().length === 0) {
        throw new JamError(
          "JAM_WRITE_OPERATION_NOT_ALLOWED",
          "status.transition needs non-empty `input.status`.",
          { operation },
        );
      }
      return { status: status.trim() };
    }
    case "assignee.update": {
      const assignee = (raw as AssigneeUpdateInput).assignee;
      if (typeof assignee !== "string" || assignee.trim().length === 0) {
        throw new JamError(
          "JAM_WRITE_OPERATION_NOT_ALLOWED",
          "assignee.update needs non-empty `input.assignee` - a display name, or an accountId.",
          { operation },
        );
      }
      return { assignee: assignee.trim() };
    }
  }
}

async function describe(
  deps: JamDeps,
  operation: ExistingIssueOperation,
  issueKey: string,
  snapshot: IssueSnapshot,
  input: WriteInput,
): Promise<{
  before: Record<string, unknown>;
  intendedAfter: Record<string, unknown>;
  mutation: WriteMutation;
  transition?: ExistingIssueWritePlan["transition"];
  baseAssigneeAccountId?: string;
}> {
  const issue = snapshot.issue;
  switch (operation) {
    case "comment.add": {
      const { text } = input as CommentAddInput;
      // Comments accumulate rather than replace, so `before` says what is
      // there now by count - the plan is not claiming to know the thread.
      return {
        before: { comments: issue.comments.length },
        intendedAfter: { commentAdded: text },
        mutation: { kind: "comment", text },
      };
    }

    case "field.update": {
      const fields = input as FieldUpdateInput;
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(fields)) {
        before[field] = currentValue(issue, field);
        after[field] = value;
      }
      return {
        before,
        intendedAfter: after,
        mutation: { kind: "fields", fields: toJiraFields(fields) },
      };
    }

    case "status.transition": {
      const { status: target } = input as StatusTransitionInput;
      // Ask Jira what is reachable rather than deriving an id from a name:
      // transition ids are per-workflow, and a guessed one either fails or
      // moves the issue somewhere nobody asked for.
      const available = await deps.jiraWrite.getTransitions(issueKey);
      const transition = resolveTransition(target, available);
      return {
        before: { status: issue.status },
        intendedAfter: { status: transition.to },
        mutation: { kind: "transition", transitionId: transition.id },
        transition,
      };
    }

    case "assignee.update": {
      const { assignee: requested } = input as AssigneeUpdateInput;

      // Ask Jira who this is, and decide from what it says. The requested
      // string never reaches a mutation: what gets written is the accountId
      // that resolution settled on, and resolution refuses rather than picks
      // when the answer is not one person.
      const candidates = await deps.jiraAssignees.searchUsers(requested);
      const target = resolveAssignee(requested, candidates);

      // Two independent refusals, in the order that costs least. Already-set
      // needs no Jira call; assignability does.
      assertNotAlreadyAssigned(issueKey, snapshot.assigneeAccountId, target);
      assertAssignable(
        issueKey,
        target,
        await deps.jiraAssignees.isAssignable(issueKey, target.accountId),
      );

      return {
        before: {
          assignee: snapshot.assigneeAccountId
            ? { accountId: snapshot.assigneeAccountId, displayName: issue.assignee ?? "" }
            : null,
        },
        intendedAfter: { assignee: target },
        mutation: { kind: "assignee", accountId: target.accountId },
        ...(snapshot.assigneeAccountId
          ? { baseAssigneeAccountId: snapshot.assigneeAccountId }
          : {}),
      };
    }
  }
}

function currentValue(issue: FullIssueContext, field: string): unknown {
  switch (field) {
    case "summary":
      return issue.summary;
    case "priority":
      return issue.priority;
    case "labels":
      return issue.labels;
    case "components":
      return issue.components;
    default:
      return undefined;
  }
}

/** Whitelisted values to the shapes Jira's field API expects. */
function toJiraFields(input: FieldUpdateInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (input.summary !== undefined) fields["summary"] = input.summary;
  if (input.priority !== undefined) fields["priority"] = { name: input.priority };
  if (input.labels !== undefined) fields["labels"] = input.labels;
  if (input.components !== undefined) {
    fields["components"] = input.components.map((name) => ({ name }));
  }
  return fields;
}
