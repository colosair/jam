import type { JamDeps } from "../deps.js";
import type { FullIssueContext } from "../domain/context.js";
import { JamError, toJamError } from "../domain/errors.js";
import type { CreateIssueInput, CreateIssueWritePlan, WriteApplyReceipt } from "../domain/write.js";
import { canonicalizePlainText } from "../domain/adf.js";
import { assertSchemaUnchanged } from "../policy/create-policy.js";
import { projectKeyOf } from "../policy/write-policy.js";
import { readIssue } from "./plan-write.js";

/**
 * Create the issue a plan describes, then go and look at what was created.
 *
 * The same three-step shape as every other apply, with one substitution.
 * Updating an existing issue re-reads that issue and compares its revision;
 * there is no issue to re-read here, so what gets checked instead is the
 * premise the plan was built on - the project's create schema. That is
 * creation's concurrency boundary.
 *
 *  1. Re-derive the schema and check the plan's premises still hold. If the
 *     issue type went away, or a required field JAM cannot fill appeared, or a
 *     resolved value is no longer offered, nothing is sent.
 *  2. POST the create exactly once. No retry, ever - see below.
 *  3. Read the new issue by the key Jira returned, and check it says what the
 *     plan intended. A 201 with a key is Jira accepting a request, not
 *     evidence that the issue exists as described.
 */
export async function applyCreateIssue(
  deps: JamDeps,
  plan: CreateIssueWritePlan,
): Promise<WriteApplyReceipt> {
  if (plan.mutation.kind !== "create") {
    throw new JamError("CONFIG_INVALID", "A create-issue plan must carry a create mutation.");
  }

  await revalidateSchema(deps, plan);

  const created = await create(deps, plan);

  const after = await verify(deps, plan, created.key);

  deps.writePlans.consume(plan.planId);

  return {
    status: "applied",
    issue: created.key,
    operation: plan.operation,
    before: plan.before,
    after,
    verified: true,
  };
}

/**
 * Ask Jira for the create schema again, and check the plan still stands.
 *
 * Deliberately not a comparison of the two metadata documents. The question is
 * not "is the schema identical" - on an active project it rarely is - but "are
 * this plan's premises still true". See assertSchemaUnchanged.
 */
async function revalidateSchema(deps: JamDeps, plan: CreateIssueWritePlan): Promise<void> {
  const { projectKey, schemaRequirements } = plan;
  const issueTypes = await deps.jiraCreateMetadata.getIssueTypes(projectKey);
  const fields = await deps.jiraCreateMetadata.getCreateFields(
    projectKey,
    schemaRequirements.issueTypeId,
  );

  assertSchemaUnchanged(schemaRequirements, issueTypes, fields, intendedInput(plan));
}

/**
 * The create request as an input again, for re-running the required-field gate.
 *
 * Derived from `intendedAfter` rather than kept as a second copy of the
 * request: one record of what this plan intends, read two ways.
 */
function intendedInput(plan: CreateIssueWritePlan): CreateIssueInput {
  const after = plan.intendedAfter;
  return {
    issueType: plan.schemaRequirements.issueTypeName,
    summary: String(after["summary"] ?? ""),
    ...(after["description"] !== undefined ? { description: String(after["description"]) } : {}),
    ...(after["priority"] !== undefined ? { priority: String(after["priority"]) } : {}),
    ...(Array.isArray(after["labels"]) ? { labels: after["labels"] as string[] } : {}),
    ...(Array.isArray(after["components"]) ? { components: after["components"] as string[] } : {}),
  };
}

/**
 * Send the create, once.
 *
 * There is no retry here and there must not be one. This is the sharpest
 * version of the rule the whole write plane follows: a create that fails
 * ambiguously may already have produced an issue, and resending it produces a
 * second one - on someone's board, in someone's sprint, with a key nobody is
 * holding. So an ambiguous failure becomes JAM_WRITE_UNCERTAIN and says what
 * to do about it: look in the project, do not send it again.
 */
async function create(deps: JamDeps, plan: CreateIssueWritePlan): Promise<{ key: string }> {
  if (plan.mutation.kind !== "create") {
    throw new JamError("CONFIG_INVALID", "A create-issue plan must carry a create mutation.");
  }
  try {
    return await deps.jiraWrite.createIssue(plan.mutation.fields);
  } catch (err) {
    const jamError = toJamError(err);
    if (!isAmbiguous(jamError)) throw jamError;
    throw new JamError(
      "JAM_WRITE_UNCERTAIN",
      `JAM could not tell whether the issue was created in ${plan.projectKey}: ${jamError.message} Look in the project to find out - do not retry this write, which could create a second issue.`,
      { project: plan.projectKey, operation: plan.operation, cause: jamError.code },
    );
  }
}

/**
 * A failure that says nothing about whether Jira acted.
 *
 * A 403 or a 400 is a decision Jira made and did not act on. A dropped
 * connection or a 5xx is not: the request may have been processed before the
 * answer went missing. JAM_WRITE_UNCERTAIN raised inside the adapter - Jira
 * accepted a create but named no issue - is ambiguous by construction and
 * passes through unchanged.
 */
function isAmbiguous(err: JamError): boolean {
  return (
    err.code === "JIRA_UNAVAILABLE" ||
    err.code === "RATE_LIMITED" ||
    err.code === "JAM_WRITE_UNCERTAIN"
  );
}

/**
 * Read the created issue and check it is the one the plan described.
 *
 * Every field in `intendedAfter` is checked, because `intendedAfter` is also
 * what the plan receipt promised `verification.expects` would show. A field
 * the receipt names and the check skips is worse than one it never named: it
 * reports `verified: true` about something nobody looked at.
 *
 * Only the fields the create contract lets a caller ask for are in there.
 * Jira fills in a great deal on its own - reporter, created, status, whatever
 * a project's automation adds - and none of that was requested, so requiring
 * it to match something would be inventing an expectation nobody stated.
 */
async function verify(
  deps: JamDeps,
  plan: CreateIssueWritePlan,
  issueKey: string,
): Promise<Record<string, unknown>> {
  // Where the issue landed is part of what was intended. The workspace binding
  // is the whole of JAM's write scope, so a key from another project coming
  // back from a create is the one outcome that must never be reported as the
  // create that was planned.
  const createdProject = projectKeyOf(issueKey);
  if (createdProject !== plan.projectKey) {
    throw verificationFailed(
      plan,
      issueKey,
      { project: plan.projectKey },
      { project: createdProject ?? issueKey },
    );
  }

  const { issue } = await readIssue(deps, issueKey);

  const observed: Record<string, unknown> = {};
  for (const field of Object.keys(plan.intendedAfter)) {
    observed[field] = observedValue(issue, field);
  }

  for (const [field, expected] of Object.entries(plan.intendedAfter)) {
    if (!sameValue(observed[field], expected)) {
      throw verificationFailed(plan, issueKey, plan.intendedAfter, observed);
    }
  }

  return observed;
}

/**
 * The created issue's value for one requested field.
 *
 * The description is canonicalized on the way out, the same way the plan
 * canonicalized what was asked for. Jira stores a document and renders it back
 * as text, so the two are never byte-identical - and a comparison that failed
 * on Jira's own formatting would be reporting a problem that is not there.
 */
function observedValue(issue: FullIssueContext, field: string): unknown {
  switch (field) {
    case "issueType":
      return issue.issueType;
    case "summary":
      return issue.summary;
    case "description":
      return issue.description === undefined
        ? undefined
        : canonicalizePlainText(issue.description);
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

/**
 * The issue exists. Say so, and say not to make another one.
 *
 * This is the failure an agent is most likely to answer by trying again, and
 * trying again is the one thing that turns a wrong issue into two wrong
 * issues.
 */
function verificationFailed(
  plan: CreateIssueWritePlan,
  issueKey: string,
  expected: Record<string, unknown>,
  observed: Record<string, unknown>,
): JamError {
  return new JamError(
    "JAM_WRITE_VERIFICATION_FAILED",
    `Jira created ${issueKey}, but a direct read does not show what the plan intended. A workflow rule or a project automation may have altered the issue as it was created. The issue exists - look at it and fix it there, or delete it. Do not create another one.`,
    { issueKey, operation: plan.operation, expected, observed },
  );
}

function sameValue(observed: unknown, expected: unknown): boolean {
  if (Array.isArray(expected) || Array.isArray(observed)) {
    const a = Array.isArray(observed) ? [...observed].map(String).sort() : [];
    const b = Array.isArray(expected) ? [...expected].map(String).sort() : [];
    return a.length === b.length && a.every((value, i) => value === b[i]);
  }
  return observed === expected;
}
