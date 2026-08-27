import type { EditFieldMetadata, EditFieldOption } from "../../domain/write.js";
import type { CredentialPort } from "../../ports/credentials.port.js";
import type { JiraEditMetadataPort } from "../../ports/jira-edit-metadata.port.js";
import { JiraClient } from "./jira-client.js";

type RawEditField = {
  name?: unknown;
  required?: unknown;
  operations?: unknown;
  schema?: { type?: unknown; items?: unknown; custom?: unknown; customId?: unknown };
  allowedValues?: unknown;
};

/**
 * Jira Cloud REST v3 edit metadata for one issue.
 *
 * `GET /rest/api/3/issue/{key}/editmeta`, `retry: false`. Its answer decides
 * whether a mutation may proceed and what shape it takes, so a
 * retried-and-stale answer is worse than a failure - the same argument that
 * keeps `getTransitions`, the create metadata calls and the assignability
 * check on the non-retrying side.
 *
 * Jira keys the response by field id, and describes each field with a `schema`
 * and a list of `operations`. Both travel, because both are what the decision
 * is made in; the rest of the document does not.
 *
 * Anything JAM cannot read is dropped rather than half-understood. A field
 * that survives here with the wrong shape would be a field JAM claims to
 * understand well enough to write.
 */
export class JiraCloudEditMetadataAdapter implements JiraEditMetadataPort {
  private readonly client: JiraClient;

  constructor(credentials: CredentialPort, fetchImpl?: typeof fetch) {
    this.client = fetchImpl ? new JiraClient(credentials, fetchImpl) : new JiraClient(credentials);
  }

  async getEditableFields(issueKey: string): Promise<EditFieldMetadata[]> {
    const { data } = await this.client.request<{ fields?: Record<string, RawEditField> }>({
      path: `rest/api/3/issue/${encodeURIComponent(issueKey)}/editmeta`,
      retry: false,
    });

    const fields = data?.fields;
    if (!fields || typeof fields !== "object") return [];

    return Object.entries(fields)
      .map(([id, raw]) => toEditField(id, raw))
      .filter((f): f is EditFieldMetadata => f !== undefined);
  }
}

function toEditField(id: string, raw: RawEditField): EditFieldMetadata | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  // A field with no schema type is a field JAM cannot classify, and an
  // unclassifiable field is one it must not decide it can write.
  const type = typeof raw.schema?.type === "string" ? raw.schema.type : undefined;
  if (!type) return undefined;

  const allowed = toOptions(raw.allowedValues);

  return {
    id,
    name: typeof raw.name === "string" ? raw.name : id,
    required: raw.required === true,
    operations: Array.isArray(raw.operations)
      ? raw.operations.filter((op): op is string => typeof op === "string")
      : [],
    schema: {
      type,
      ...(typeof raw.schema?.items === "string" ? { items: raw.schema.items } : {}),
      ...(typeof raw.schema?.custom === "string" ? { custom: raw.schema.custom } : {}),
      ...(typeof raw.schema?.customId === "number" ? { customId: raw.schema.customId } : {}),
    },
    ...(allowed ? { allowedValues: allowed } : {}),
  };
}

/**
 * The options Jira offers, when it constrains the field at all.
 *
 * Absent and empty mean different things and stay apart: absent is "Jira did
 * not constrain this", empty is "Jira constrains it and offers nothing". The
 * first permits a free value, the second permits none.
 *
 * Jira labels an option `value` on a select and `name` on some other pickers.
 * Both are read; an option with neither an id nor a label is dropped, because
 * it can be neither chosen nor recognised afterwards.
 */
function toOptions(raw: unknown): EditFieldOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  return raw
    .map((entry) => {
      const o = entry as { id?: unknown; value?: unknown; name?: unknown };
      const id = typeof o?.id === "string" ? o.id : typeof o?.id === "number" ? String(o.id) : undefined;
      const label =
        typeof o?.value === "string" ? o.value : typeof o?.name === "string" ? o.name : undefined;
      return id && label ? { id, label } : undefined;
    })
    .filter((o): o is EditFieldOption => o !== undefined);
}
