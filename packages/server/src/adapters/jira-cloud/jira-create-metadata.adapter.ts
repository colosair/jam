import type { CreateFieldMetadata, CreateIssueType } from "../../domain/write.js";
import type { CredentialPort } from "../../ports/credentials.port.js";
import type { JiraCreateMetadataPort } from "../../ports/jira-create-metadata.port.js";
import { JiraClient } from "./jira-client.js";

type RawIssueType = {
  id?: string;
  name?: string;
  subtask?: boolean;
};

type RawField = {
  fieldId?: string;
  key?: string;
  name?: string;
  required?: boolean;
  hasDefaultValue?: boolean;
  allowedValues?: { id?: unknown; name?: unknown; value?: unknown }[];
};

/**
 * Jira Cloud REST v3 create metadata, per project and per issue type.
 *
 * The two-endpoint form, not the aggregate `createmeta?expand=` one: the
 * aggregate endpoint is deprecated on Jira Cloud and returns every issue type's
 * every field in one document, which is both larger and less precise than the
 * question being asked. Planning wants one project's issue types, and then one
 * issue type's fields.
 *
 * `retry: false` throughout. These answers decide whether a create is possible
 * and what it will contain, so a retried-and-stale answer is worse than a
 * failure - the same reason `getTransitions` does not retry.
 *
 * Both mappers are defensive about shape. Jira omits fields it considers
 * irrelevant and different deployments populate different ones, so anything
 * unrecognised is dropped rather than guessed at: an entry JAM cannot read is
 * an entry JAM must not claim to have understood.
 */
export class JiraCloudCreateMetadataAdapter implements JiraCreateMetadataPort {
  private readonly client: JiraClient;

  constructor(credentials: CredentialPort, fetchImpl?: typeof fetch) {
    this.client = fetchImpl ? new JiraClient(credentials, fetchImpl) : new JiraClient(credentials);
  }

  async getIssueTypes(projectKey: string): Promise<CreateIssueType[]> {
    const { data } = await this.client.request<{ issueTypes?: RawIssueType[] }>({
      path: `rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
      retry: false,
    });

    return (data.issueTypes ?? [])
      .filter((t): t is RawIssueType & { id: string; name: string } =>
        typeof t.id === "string" && typeof t.name === "string",
      )
      .map((t) => ({ id: t.id, name: t.name, subtask: t.subtask === true }));
  }

  async getCreateFields(projectKey: string, issueTypeId: string): Promise<CreateFieldMetadata[]> {
    const { data } = await this.client.request<{ fields?: RawField[] }>({
      path: `rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}`,
      retry: false,
    });

    return (data.fields ?? [])
      .map(toFieldMetadata)
      .filter((f): f is CreateFieldMetadata => f !== undefined);
  }
}

function toFieldMetadata(raw: RawField): CreateFieldMetadata | undefined {
  // Jira has called this `fieldId` and `key` in different responses. Without
  // one of them the entry cannot be matched to anything, so it is dropped -
  // and if it was required, the required-field gate will refuse the plan
  // because JAM cannot show it was supplied.
  const id = typeof raw.fieldId === "string" ? raw.fieldId : typeof raw.key === "string" ? raw.key : undefined;
  if (!id) return undefined;

  const allowed = mapAllowedValues(raw.allowedValues);

  return {
    id,
    name: typeof raw.name === "string" ? raw.name : id,
    required: raw.required === true,
    hasDefaultValue: raw.hasDefaultValue === true,
    ...(allowed ? { allowedValues: allowed } : {}),
  };
}

/**
 * Allowed values, when Jira constrains the field at all.
 *
 * Undefined and empty mean different things and are kept apart: undefined is
 * "Jira did not constrain this", empty is "Jira constrains it and offers
 * nothing". The first permits a free value, the second permits none.
 */
function mapAllowedValues(
  raw: RawField["allowedValues"],
): CreateFieldMetadata["allowedValues"] | undefined {
  if (!Array.isArray(raw)) return undefined;

  return raw.map((entry) => {
    const id = typeof entry?.id === "string" ? entry.id : undefined;
    // Components and priorities use `name`; some option fields use `value`.
    const name =
      typeof entry?.name === "string"
        ? entry.name
        : typeof entry?.value === "string"
          ? entry.value
          : undefined;
    return { ...(id ? { id } : {}), ...(name ? { name } : {}) };
  });
}
