import type { ProjectConfig } from "../config/schema.js";
import { JamError } from "../domain/errors.js";
import type {
  CustomFieldKind,
  CustomFieldRequirements,
  CustomFieldUpdateInput,
  CustomFieldValueView,
  EditFieldMetadata,
  EditFieldOption,
} from "../domain/write.js";

/**
 * What JAM will write to a custom field, and everything that has to be true
 * first.
 *
 * Three separate permissions have to line up, and none of them implies
 * another:
 *
 *  1. **The team said so.** The field's exact id is in the project's whitelist
 *     with `writable: true`. Being readable is not being writable - reading a
 *     field and letting an agent change it are different decisions, and a
 *     config written before JAM could write must not start granting writes
 *     because JAM learned how.
 *  2. **Jira allows it here and now.** The field is on this issue's edit
 *     screen for this account, and Jira lists `set` among its operations.
 *     Asked, never modelled: applicability depends on project, issue type,
 *     field contexts, screens and permissions, and JAM does not carry a copy
 *     of any of that.
 *  3. **JAM knows the shape.** The field's type is one of four families whose
 *     wire form JAM can produce from a plain value and compare afterwards.
 *     Anything else is refused rather than posted to find out.
 */

type WritableField = { id: string; name: string };

/**
 * Which configured field this selector names.
 *
 * The id is the identity; the name is an alias for people. Resolution is exact
 * on either - no substring, no fuzz - because the alternative is an agent's
 * approximate word choosing which field on somebody's board gets rewritten.
 *
 * Only `writable: true` entries are candidates, including for the refusal
 * message: naming a read-only field as an alternative would suggest it is one
 * selector away from being written.
 */
export function resolveWritableField(config: ProjectConfig, requested: string): WritableField {
  const wanted = requested.trim();
  if (wanted.length === 0) {
    throw new JamError(
      "JAM_WRITE_OPERATION_NOT_ALLOWED",
      "custom-field.update needs a non-empty `input.field`.",
      { operation: "custom-field.update" },
    );
  }

  const writable = config.customFields.filter((f) => f.writable);
  const match =
    writable.find((f) => f.id.toLowerCase() === wanted.toLowerCase()) ??
    writable.find((f) => f.name.trim().toLowerCase() === wanted.toLowerCase());

  if (!match) {
    throw new JamError(
      "JAM_WRITE_FIELD_NOT_ALLOWED",
      writable.length === 0
        ? `No custom field in this project is writable. A team opts one in by adding \`writable: true\` to its entry in .jira-agent/project.yaml; being readable does not make a field writable.`
        : `"${requested}" is not a writable custom field in this project. JAM writes only the exact ids a team has opted in.`,
      {
        requested,
        writableCustomFields: writable.map((f) => ({ id: f.id, name: f.name })),
      },
    );
  }

  return { id: match.id, name: match.name };
}

/**
 * The field as Jira currently offers it on this issue, or a refusal.
 *
 * Absent from the edit metadata and present-but-not-settable are different
 * situations with the same answer for the caller, so they share a code and
 * differ in the detail: one means the field is not on this screen, the other
 * that Jira will not let this account set it.
 */
export function assertEditable(
  issueKey: string,
  field: WritableField,
  metadata: EditFieldMetadata[],
): EditFieldMetadata {
  const found = metadata.find((f) => f.id === field.id);
  if (!found) {
    throw new JamError(
      "JAM_WRITE_CUSTOM_FIELD_NOT_EDITABLE",
      `Jira does not offer ${field.name} (${field.id}) on ${issueKey}'s edit screen for this account. The field may not apply to this project or issue type, or this account may not be able to edit it.`,
      { issueKey, fieldId: field.id, fieldName: field.name, reason: "NOT_ON_EDIT_SCREEN" },
    );
  }

  if (!found.operations.includes("set")) {
    throw new JamError(
      "JAM_WRITE_CUSTOM_FIELD_NOT_EDITABLE",
      `Jira lists ${field.name} (${field.id}) on ${issueKey} but does not offer "set" for it${found.operations.length > 0 ? ` - only ${found.operations.join(", ")}` : ""}. JAM only sets a value; it does not add to or remove from one.`,
      {
        issueKey,
        fieldId: field.id,
        fieldName: field.name,
        operations: found.operations,
        reason: "SET_NOT_OFFERED",
      },
    );
  }

  return found;
}

/**
 * Which of the four families this field belongs to, if any.
 *
 * Classified from Jira's own `schema`, which is the vocabulary Jira answers
 * in. The implementation key (`schema.custom`) deliberately does not decide
 * it: there are hundreds of them, they are app-specific, and a field's wire
 * shape follows its type rather than its plugin.
 *
 * Anything unclassified is refused. Posting an unknown type to see what
 * happens would use a Jira 400 as schema discovery, and on the occasions it
 * did not 400 it would write something nobody described.
 */
export function classifyKind(field: EditFieldMetadata): CustomFieldKind {
  const { type, items } = field.schema;

  if (type === "string" && !items) return "text";
  if (type === "number" && !items) return "number";
  if (type === "option" && !items) return "single-option";
  if (type === "array" && items === "option") return "multi-option";

  throw new JamError(
    "JAM_WRITE_CUSTOM_FIELD_TYPE_UNSUPPORTED",
    `${field.name} (${field.id}) is a ${describeType(field)} field, and JAM does not know how to write one safely yet. Supported: single-line text, number, single-select and multi-select.`,
    {
      fieldId: field.id,
      fieldName: field.name,
      schema: field.schema,
      supported: ["text", "number", "single-option", "multi-option"],
    },
  );
}

function describeType(field: EditFieldMetadata): string {
  const { type, items } = field.schema;
  return items ? `${type} of ${items}` : type;
}

/**
 * The value, checked against the family and turned into what Jira expects.
 *
 * Types are never coerced. `"5"` is not `5`: a caller that meant a number can
 * say so, and silently converting would make JAM's idea of the value differ
 * from the caller's in exactly the cases where it matters.
 *
 * Nothing here clears a field. Empty strings, empty arrays and null are
 * refused rather than treated as "unset" - removing a value is a different
 * intent from setting one, and it is not in this version.
 */
export function resolveCustomFieldValue(
  field: EditFieldMetadata,
  kind: CustomFieldKind,
  input: CustomFieldUpdateInput,
): { jiraValue: unknown; view: CustomFieldValueView; resolvedOptions?: EditFieldOption[] } {
  const { value } = input;
  const named = { id: field.id, name: field.name };

  switch (kind) {
    case "text": {
      if (typeof value !== "string") throw wrongType(field, kind, value);
      const text = value.trim();
      if (text.length === 0) throw refuseClear(field);
      return { jiraValue: text, view: { ...named, value: text } };
    }

    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw wrongType(field, kind, value);
      return { jiraValue: value, view: { ...named, value } };
    }

    case "single-option": {
      if (typeof value !== "string") throw wrongType(field, kind, value);
      const option = resolveOption(field, value);
      // Jira takes the option by id. The label is what a person reads, and two
      // options could carry the same one.
      return {
        jiraValue: { id: option.id },
        view: { ...named, value: option },
        resolvedOptions: [option],
      };
    }

    case "multi-option": {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        throw wrongType(field, kind, value);
      }
      if (value.length === 0) throw refuseClear(field);

      const seen = new Set<string>();
      for (const raw of value) {
        const key = raw.trim().toLowerCase();
        if (seen.has(key)) {
          throw new JamError(
            "JAM_WRITE_VALUE_NOT_ALLOWED",
            `"${raw}" appears more than once in the value for ${field.name}. JAM does not quietly drop the repeat - say each option once.`,
            { fieldId: field.id, repeated: raw },
          );
        }
        seen.add(key);
      }

      // Every option resolves, or none is written. A partly-applied selection
      // is a selection nobody asked for.
      const options = value.map((raw) => resolveOption(field, raw));
      return {
        jiraValue: options.map((o) => ({ id: o.id })),
        view: { ...named, value: options },
        resolvedOptions: options,
      };
    }
  }
}

/**
 * Which option Jira offers under this name, if exactly one does.
 *
 * An option id wins outright, then an exact label ignoring case and space.
 * Nothing partial: Jira's option lists are short and a caller can name one
 * exactly, so a near miss is a question rather than a guess.
 */
function resolveOption(field: EditFieldMetadata, requested: string): EditFieldOption {
  const allowed = field.allowedValues;
  if (!allowed) {
    throw new JamError(
      "JAM_WRITE_CUSTOM_FIELD_TYPE_UNSUPPORTED",
      `${field.name} (${field.id}) is a select field, but Jira did not say which options it offers, so JAM cannot resolve "${requested}" to one.`,
      { fieldId: field.id, fieldName: field.name, schema: field.schema },
    );
  }

  const wanted = requested.trim();
  const byId = allowed.filter((o) => o.id === wanted);
  const matches =
    byId.length > 0
      ? byId
      : allowed.filter((o) => o.label.trim().toLowerCase() === wanted.toLowerCase());

  if (matches.length === 0) {
    throw new JamError(
      "JAM_WRITE_VALUE_NOT_ALLOWED",
      allowed.length === 0
        ? `Jira offers no options for ${field.name} on this issue, so "${requested}" cannot be set.`
        : `"${requested}" is not an option Jira offers for ${field.name}. Allowed: ${allowed.map((o) => o.label).join(", ")}.`,
      { fieldId: field.id, requested, allowed },
    );
  }

  if (matches.length > 1) {
    throw new JamError(
      "JAM_WRITE_VALUE_NOT_ALLOWED",
      `"${requested}" matches ${matches.length} options for ${field.name}. Pass the option id of the one you mean.`,
      { fieldId: field.id, requested, candidates: matches },
    );
  }

  return matches[0]!;
}

/**
 * Do this plan's premises still hold?
 *
 * Semantic, like the create schema check and for the same reason: comparing
 * whole metadata documents would invalidate every outstanding plan whenever an
 * unrelated field appeared on the screen. What is compared is what the plan
 * actually rested on - the field is still settable, still the same family,
 * still the same schema, and every option it chose is still offered under the
 * same label.
 *
 * A renamed option is treated as a changed one. The id is the identity, but a
 * label is what the plan showed a human before they agreed to it, and "Backend"
 * becoming "Platform" is a different statement about the issue.
 */
export function assertCustomFieldUnchanged(
  issueKey: string,
  requirements: CustomFieldRequirements,
  metadata: EditFieldMetadata[],
): void {
  const field = metadata.find((f) => f.id === requirements.fieldId);
  if (!field) {
    throw schemaChanged(
      `${requirements.fieldName} (${requirements.fieldId}) is no longer on ${issueKey}'s edit screen for this account.`,
      { issueKey, fieldId: requirements.fieldId },
    );
  }

  if (!field.operations.includes("set")) {
    throw schemaChanged(
      `Jira no longer offers "set" for ${requirements.fieldName} on ${issueKey}.`,
      { issueKey, fieldId: field.id, operations: field.operations },
    );
  }

  if (
    field.schema.type !== requirements.schema.type ||
    field.schema.items !== requirements.schema.items
  ) {
    throw schemaChanged(
      `${requirements.fieldName} is no longer a ${requirements.kind} field.`,
      { issueKey, fieldId: field.id, planned: requirements.schema, current: field.schema },
    );
  }

  for (const planned of requirements.resolvedOptions ?? []) {
    const current = field.allowedValues?.find((o) => o.id === planned.id);
    if (!current) {
      throw schemaChanged(
        `Option "${planned.label}" is no longer offered for ${requirements.fieldName}.`,
        { issueKey, fieldId: field.id, option: planned },
      );
    }
    if (current.label !== planned.label) {
      throw schemaChanged(
        `Option "${planned.label}" has been renamed to "${current.label}", so this plan no longer describes the change it showed.`,
        { issueKey, fieldId: field.id, planned, current },
      );
    }
  }
}

function schemaChanged(what: string, details: Record<string, unknown>): JamError {
  return new JamError(
    "JAM_WRITE_SCHEMA_CHANGED",
    `${what} This plan was built on the field's configuration as it was, so it no longer describes a change JAM can make. Nothing was written - plan again.`,
    details,
  );
}

function wrongType(field: EditFieldMetadata, kind: CustomFieldKind, value: unknown): JamError {
  const wanted = {
    text: "a string",
    number: "a number",
    "single-option": "a string naming one option",
    "multi-option": "an array of strings naming options",
  }[kind];

  return new JamError(
    "JAM_WRITE_VALUE_NOT_ALLOWED",
    `${field.name} (${field.id}) is a ${kind} field and needs ${wanted}. JAM does not convert between types - "5" and 5 are different values, and guessing which was meant is not JAM's to do.`,
    { fieldId: field.id, kind, received: typeof value },
  );
}

function refuseClear(field: EditFieldMetadata): JamError {
  return new JamError(
    "JAM_WRITE_VALUE_NOT_ALLOWED",
    `custom-field.update sets a value; it does not clear one. ${field.name} cannot be set to an empty value in this version.`,
    { fieldId: field.id, reason: "CLEAR_NOT_SUPPORTED" },
  );
}
