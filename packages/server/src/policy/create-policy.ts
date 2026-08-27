import { JamError } from "../domain/errors.js";
import {
  CREATABLE_FIELDS,
  type CreateFieldMetadata,
  type CreateIssueInput,
  type CreateIssueType,
  type CreateSchemaRequirements,
} from "../domain/write.js";

/**
 * What JAM will agree to create, decided from what Jira says it accepts.
 *
 * Creation is the one write with no issue to look at first, so every check
 * here is against the project's create schema instead. The rule throughout is
 * the one the rest of the write plane follows: resolve against what Jira just
 * reported, never against what the caller asserted or what a name suggests. An
 * issue type id is not derived from a type name, a priority is not sent
 * because it looked plausible, and a required field JAM cannot express is
 * refused here rather than posted and rejected as a 400.
 */

/**
 * Jira field ids for the fields JAM can put on a create.
 *
 * The bridge between the public contract (CREATABLE_FIELDS, which an agent
 * sees) and Jira's own ids (which the required-field gate compares against).
 * Both directions matter: one decides what may be asked for, the other decides
 * what counts as "JAM supplies this".
 */
export const CREATE_FIELD_IDS = {
  issueType: "issuetype",
  summary: "summary",
  description: "description",
  priority: "priority",
  labels: "labels",
  components: "components",
} as const satisfies Record<(typeof CREATABLE_FIELDS)[number], string>;

/** Always sent by JAM, so a project requiring them is still servable. */
const ALWAYS_SUPPLIED: string[] = [CREATE_FIELD_IDS.issueType, CREATE_FIELD_IDS.summary, "project"];

/**
 * Fields JAM can supply when asked, and so can satisfy a required flag - but
 * only if the caller actually asked for them. Required-and-absent is refused.
 */
const SUPPLIABLE_ON_REQUEST: Record<string, keyof CreateIssueInput> = {
  [CREATE_FIELD_IDS.description]: "description",
  [CREATE_FIELD_IDS.priority]: "priority",
  [CREATE_FIELD_IDS.labels]: "labels",
  [CREATE_FIELD_IDS.components]: "components",
};

/**
 * Match a requested issue type against the ones Jira offers for this project.
 *
 * Case-insensitive, because "task" and "Task" are the same intent and an agent
 * has no way to learn Jira's casing before asking. Nothing else is inferred:
 * the id comes from Jira's own list, and a type that is not on it is refused
 * with the list attached, so the next move is to pick one rather than to
 * rephrase the same one.
 *
 * Subtask types are refused separately. They need a parent, which is not in
 * this version's contract, so "not available" would be the wrong answer - the
 * type exists, and JAM cannot use it yet.
 */
export function resolveIssueType(requested: string, available: CreateIssueType[]): CreateIssueType {
  const wanted = requested.trim().toLowerCase();
  const match = available.find((t) => t.name.toLowerCase() === wanted);

  if (!match) {
    const creatable = available.filter((t) => !t.subtask).map((t) => t.name);
    throw new JamError(
      "JAM_WRITE_ISSUE_TYPE_NOT_AVAILABLE",
      creatable.length === 0
        ? `Jira offers no issue types this account can create in this project, so "${requested}" cannot be created.`
        : `"${requested}" is not an issue type this account can create in this project. Available: ${creatable.join(", ")}.`,
      {
        requested,
        available: available.map((t) => ({ id: t.id, name: t.name, subtask: t.subtask })),
      },
    );
  }

  if (match.subtask) {
    throw new JamError(
      "JAM_WRITE_ISSUE_TYPE_NOT_AVAILABLE",
      `"${match.name}" is a subtask type, which needs a parent issue. JAM does not set a parent, so it cannot create one.`,
      { requested, issueType: match.name, reason: "SUBTASK_UNSUPPORTED" },
    );
  }

  return match;
}

/**
 * Refuse a create whose project requires something JAM cannot put on it.
 *
 * The alternative - post it and let Jira answer 400 - is worse twice over: the
 * agent gets a vendor error instead of a JAM decision, and creation is the one
 * write where "did it happen?" is expensive to answer after the fact. So the
 * answer is worked out before anything is sent.
 *
 * A field Jira says it will default is not JAM's to supply. That is Jira
 * stating a fact about its own configuration, not JAM guessing one.
 *
 * Returns the required field ids, which the plan records so apply can tell a
 * newly-required field from one that was always there.
 */
export function assertRequiredFieldsSupported(
  fields: CreateFieldMetadata[],
  input: CreateIssueInput,
): string[] {
  const required = fields.filter((f) => f.required);
  const unsupported: { id: string; name: string; reason: string }[] = [];

  for (const field of required) {
    if (ALWAYS_SUPPLIED.includes(field.id)) continue;
    if (field.hasDefaultValue) continue;

    const inputKey = SUPPLIABLE_ON_REQUEST[field.id];
    if (!inputKey) {
      unsupported.push({ id: field.id, name: field.name, reason: "NOT_IN_JAM_CREATE_CONTRACT" });
      continue;
    }
    if (input[inputKey] === undefined) {
      unsupported.push({ id: field.id, name: field.name, reason: "REQUIRED_BUT_NOT_PROVIDED" });
    }
  }

  if (unsupported.length > 0) {
    const named = unsupported.map((f) => `${f.name} (${f.id})`).join(", ");
    const it = unsupported.length === 1 ? "it" : "them";
    throw new JamError(
      "JAM_WRITE_REQUIRED_FIELD_UNSUPPORTED",
      `This project requires ${named} when creating this issue type, and JAM cannot supply ${it}. Create this issue in Jira instead - JAM will not send a create it already knows Jira will reject.`,
      { unsupported, supported: [...CREATABLE_FIELDS] },
    );
  }

  return required.map((f) => f.id);
}

/**
 * Turn a requested value into one Jira currently offers for that field.
 *
 * An unconstrained field passes the value through: there is no list to check
 * it against, and inventing one would refuse valid input. Absent and empty are
 * different - absent means Jira did not constrain the field, empty means it
 * constrains it and offers nothing.
 *
 * The shape is resolveTransition's, deliberately: human intent, then
 * Jira-provided candidates, then a concrete Jira value. Nothing in between
 * guesses.
 */
export function resolveAllowedValue(
  field: CreateFieldMetadata | undefined,
  requested: string,
  label: string,
): { requested: string; resolved: string } {
  if (!field?.allowedValues) return { requested, resolved: requested };

  const wanted = requested.trim().toLowerCase();
  const match = field.allowedValues.find((v) => v.name?.toLowerCase() === wanted);

  if (!match?.name) {
    const allowed = field.allowedValues.map((v) => v.name).filter(Boolean);
    throw new JamError(
      "JAM_WRITE_VALUE_NOT_ALLOWED",
      allowed.length === 0
        ? `Jira offers no ${label} values for this project and issue type, so "${requested}" cannot be set.`
        : `"${requested}" is not an allowed ${label} for this project and issue type. Allowed: ${allowed.join(", ")}.`,
      { field: field.id, requested, allowed },
    );
  }

  return { requested, resolved: match.name };
}

/**
 * Are this plan's premises still true?
 *
 * Semantic, not a document comparison. Comparing a hash of the metadata would
 * make an unrelated optional field appearing on the create screen invalidate
 * every outstanding plan - which is wrong, and on an active project constant.
 * What matters is narrower: the issue type still exists, no new required field
 * has appeared that JAM cannot fill, and every value resolved from an allowed
 * list is still on it.
 *
 * Everything else about the schema may change freely between plan and apply.
 */
export function assertSchemaUnchanged(
  requirements: CreateSchemaRequirements,
  issueTypes: CreateIssueType[],
  fields: CreateFieldMetadata[],
  input: CreateIssueInput,
): void {
  const stillOffered = issueTypes.find((t) => t.id === requirements.issueTypeId);
  if (!stillOffered) {
    throw schemaChanged(
      `Issue type ${requirements.issueTypeName} is no longer available to this account in this project.`,
      { issueTypeId: requirements.issueTypeId, issueType: requirements.issueTypeName },
    );
  }

  // A required field JAM cannot fill is a refusal whether it was there at plan
  // time or arrived since - but arriving since is a changed schema rather than
  // a bad request, so it is reported as one.
  try {
    assertRequiredFieldsSupported(fields, input);
  } catch (err) {
    if (err instanceof JamError && err.code === "JAM_WRITE_REQUIRED_FIELD_UNSUPPORTED") {
      throw schemaChanged(
        "The create screen for this issue type now requires a field JAM cannot supply.",
        { cause: err.details },
      );
    }
    throw err;
  }

  const byId = new Map(fields.map((f) => [f.id, f]));
  for (const resolved of requirements.resolvedValues) {
    const allowed = byId.get(resolved.fieldId)?.allowedValues;
    // A field that stopped being constrained is not a problem: the value JAM
    // resolved is still a value, and Jira is no longer restricting it.
    if (!allowed) continue;
    if (!allowed.some((v) => v.name === resolved.resolved)) {
      throw schemaChanged(
        `"${resolved.resolved}" is no longer an allowed value for ${resolved.fieldId} in this project.`,
        {
          field: resolved.fieldId,
          planned: resolved.resolved,
          allowed: allowed.map((v) => v.name).filter(Boolean),
        },
      );
    }
  }
}

function schemaChanged(what: string, details: Record<string, unknown>): JamError {
  return new JamError(
    "JAM_WRITE_SCHEMA_CHANGED",
    `${what} This plan was built on the create schema as it was, so it no longer describes a create JAM can make. Nothing was created - plan again against the current schema.`,
    details,
  );
}
