import type { JamDeps } from "../deps.js";
import { JamError } from "../domain/errors.js";
import type {
  CreateIssueInput,
  CreateIssueWritePlan,
  CreateSchemaRequirements,
  WritePlanReceipt,
} from "../domain/write.js";
import { CREATABLE_FIELDS } from "../domain/write.js";
import {
  assertRequiredFieldsSupported,
  CREATE_FIELD_IDS,
  resolveAllowedValue,
  resolveIssueType,
} from "../policy/create-policy.js";
import { PLAN_TTL_MS } from "../policy/write-policy.js";
import { textToAdf } from "../domain/adf.js";

export type PlanCreateIssueRequest = { input: Record<string, unknown> };

/**
 * Work out whether an issue can be created here, and describe the one JAM
 * would create.
 *
 * Reads only - the create metadata endpoints answer questions about a
 * project's configuration and change nothing. The order is the point:
 *
 *  1. Validate the request against JAM's own contract. Anything refusable
 *     without asking Jira is refused before a round trip is spent on it.
 *  2. Ask Jira which issue types this account can create here, and resolve the
 *     requested one against that list. An id is never derived from a name.
 *  3. Ask Jira what that issue type's create screen requires, and refuse now if
 *     it requires something JAM cannot express. A create JAM knows Jira will
 *     reject is not sent.
 *  4. Resolve every constrained value against Jira's own allowed list.
 *
 * What comes out is a plan that records not just the intended issue but the
 * premises it rests on, so apply can check they still hold.
 *
 * The target project is never a parameter. It is the project this workspace is
 * bound to, which is what the user consented to when they set JAM up; taking
 * it from the caller would make the binding advisory.
 */
export async function planCreateIssue(
  deps: JamDeps,
  request: PlanCreateIssueRequest,
): Promise<{ plan: CreateIssueWritePlan; receipt: WritePlanReceipt }> {
  const projectKey = configuredProject(deps);
  const input = validateCreateInput(request.input);

  const issueTypes = await deps.jiraCreateMetadata.getIssueTypes(projectKey);
  const issueType = resolveIssueType(input.issueType, issueTypes);

  const fields = await deps.jiraCreateMetadata.getCreateFields(projectKey, issueType.id);
  const requiredFieldIds = assertRequiredFieldsSupported(fields, input);

  const byId = new Map(fields.map((f) => [f.id, f]));
  const resolvedValues: CreateSchemaRequirements["resolvedValues"] = [];

  // Only the constrained fields go through resolution. Summary and description
  // are free text, and labels are a Jira-wide vocabulary rather than a
  // per-project one, so there is no list to resolve them against.
  let priority: string | undefined;
  if (input.priority !== undefined) {
    const resolved = resolveAllowedValue(byId.get(CREATE_FIELD_IDS.priority), input.priority, "priority");
    priority = resolved.resolved;
    resolvedValues.push({ fieldId: CREATE_FIELD_IDS.priority, ...resolved });
  }

  let components: string[] | undefined;
  if (input.components !== undefined) {
    const field = byId.get(CREATE_FIELD_IDS.components);
    components = input.components.map((name) => {
      const resolved = resolveAllowedValue(field, name, "component");
      resolvedValues.push({ fieldId: CREATE_FIELD_IDS.components, ...resolved });
      return resolved.resolved;
    });
  }

  const intendedAfter: Record<string, unknown> = {
    issueType: issueType.name,
    summary: input.summary,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(input.labels !== undefined ? { labels: input.labels } : {}),
    ...(components !== undefined ? { components } : {}),
  };

  const createdAt = new Date();
  const plan = deps.writePlans.create({
    kind: "create-issue",
    projectKey,
    operation: "issue.create",
    before: { issue: null },
    intendedAfter,
    schemaRequirements: {
      issueTypeId: issueType.id,
      issueTypeName: issueType.name,
      requiredFieldIds,
      resolvedValues,
    },
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + PLAN_TTL_MS).toISOString(),
    mutation: {
      kind: "create",
      fields: toJiraCreateFields(projectKey, issueType.id, input, { priority, components }),
    },
  }) as CreateIssueWritePlan;

  return {
    plan,
    receipt: {
      status: "planned",
      planId: plan.planId,
      operation: plan.operation,
      project: plan.projectKey,
      before: plan.before,
      intendedAfter: plan.intendedAfter,
      expiresAt: plan.expiresAt,
      verification: { method: "direct-issue-read", expects: plan.intendedAfter },
    },
  };
}

/** The project this workspace is bound to, or a refusal that says so. */
export function configuredProject(deps: JamDeps): string {
  const configured = deps.config.project.key.trim().toUpperCase();
  if (!configured) {
    throw new JamError(
      "JAM_SETUP_REQUIRED",
      "No Jira project is configured for this workspace, so JAM does not know where an issue would be created.",
    );
  }
  return configured;
}

/**
 * Check the request against the create contract, and normalize it.
 *
 * Pure: no Jira, no state. `key` is not accepted here at all - there is no
 * issue to name - and neither is `project`, which comes from the binding.
 * Anything outside CREATABLE_FIELDS is rejected rather than ignored: silently
 * dropping a field an agent asked for would create an issue that is not the
 * one it described.
 */
export function validateCreateInput(raw: Record<string, unknown>): CreateIssueInput {
  const unknown = Object.keys(raw).filter(
    (key) => raw[key] !== undefined && !(CREATABLE_FIELDS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new JamError(
      "JAM_WRITE_FIELD_NOT_ALLOWED",
      `issue.create cannot set ${unknown.join(", ")}. Supported: ${CREATABLE_FIELDS.join(", ")}.`,
      { rejected: unknown, supported: [...CREATABLE_FIELDS] },
    );
  }

  const issueType = requiredText(raw["issueType"], "issueType");
  const summary = requiredText(raw["summary"], "summary");

  const input: CreateIssueInput = { issueType, summary };

  if (raw["description"] !== undefined) {
    // Plain text, never ADF. A caller-supplied document tree would mean
    // panels, mentions and embeds arriving through a field that reads like
    // prose - the same argument that keeps comment.add on plain text.
    if (typeof raw["description"] !== "string") {
      throw notAllowed("issue.create needs `input.description` to be plain text.");
    }
    input.description = raw["description"];
  }

  if (raw["priority"] !== undefined) {
    input.priority = requiredText(raw["priority"], "priority");
  }

  if (raw["labels"] !== undefined) {
    input.labels = stringArray(raw["labels"], "labels");
  }

  if (raw["components"] !== undefined) {
    input.components = stringArray(raw["components"], "components");
  }

  return input;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw notAllowed(`issue.create needs non-empty \`input.${field}\`.`);
  }
  return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw notAllowed(`issue.create needs \`input.${field}\` to be an array of strings.`);
  }
  return value as string[];
}

function notAllowed(message: string): JamError {
  return new JamError("JAM_WRITE_OPERATION_NOT_ALLOWED", message, { operation: "issue.create" });
}

/** Whitelisted values to the shapes Jira's create API expects. */
function toJiraCreateFields(
  projectKey: string,
  issueTypeId: string,
  input: CreateIssueInput,
  resolved: { priority?: string; components?: string[] },
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    project: { key: projectKey },
    issuetype: { id: issueTypeId },
    summary: input.summary,
  };
  if (input.description !== undefined) fields["description"] = textToAdf(input.description);
  if (resolved.priority !== undefined) fields["priority"] = { name: resolved.priority };
  if (input.labels !== undefined) fields["labels"] = input.labels;
  if (resolved.components !== undefined) {
    fields["components"] = resolved.components.map((name) => ({ name }));
  }
  return fields;
}
