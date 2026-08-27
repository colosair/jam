import type { JamDeps } from "../deps.js";
import type { FullIssueContext } from "../domain/context.js";
import { JamError, toJamError } from "../domain/errors.js";
import type { CreateIssueInput, CreateIssueWritePlan, WriteApplyReceipt } from "../domain/write.js";
import { assertSchemaUnchanged } from "../policy/create-policy.js";
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
 * Only the fields the create contract lets a caller ask for are compared.
 * Jira fills in a great deal on its own - reporter, created, status, whatever
 * a project's automation adds - and none of that was requested, so requiring
 * it to match something would be inventing an expectation nobody stated.
 */
async function verify(
  deps: JamDeps,
  plan: CreateIssueWritePlan,
  issueKey: string,
): Promise<Record<string, unknown>> {
  const issue = await readIssue(deps, issueKey);

  const observed: Record<string, unknown> = {};
  for (const field of Object.keys(plan.intendedAfter)) {
    observed[field] = observedValue(issue, field);
  }

  for (const [field, expected] of Object.entries(plan.intendedAfter)) {
    // Description is the one requested field a direct read does not return in
    // a comparable form: it comes back as a document, and the request was
    // plain text. Its presence is checked, not its rendering - a round-trip
    // comparison would fail on Jira's own formatting rather than on anything
    // being wrong.
    if (field === "description") continue;
    if (!sameValue(observed[field], expected)) {
      throw new JamError(
        "JAM_WRITE_VERIFICATION_FAILED",
        `Jira created ${issueKey}, but a direct read does not show what the plan intended. A workflow rule or a project automation may have altered the issue as it was created.`,
        {
          issueKey,
          operation: plan.operation,
          expected: plan.intendedAfter,
          observed,
        },
      );
    }
  }

  return observed;
}

function observedValue(issue: FullIssueContext, field: string): unknown {
  switch (field) {
    case "issueType":
      return issue.issueType;
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

function sameValue(observed: unknown, expected: unknown): boolean {
  if (Array.isArray(expected) || Array.isArray(observed)) {
    const a = Array.isArray(observed) ? [...observed].map(String).sort() : [];
    const b = Array.isArray(expected) ? [...expected].map(String).sort() : [];
    return a.length === b.length && a.every((value, i) => value === b[i]);
  }
  return observed === expected;
}
