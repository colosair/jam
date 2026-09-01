import type { EditFieldMetadata } from "../domain/write.js";

/**
 * What Jira will let this account change on one issue, right now.
 *
 * `GET /rest/api/3/issue/{key}/editmeta` is the authority, and it is asked
 * rather than reconstructed. A custom field's applicability depends on the
 * project, the issue type, the field's contexts, the screen it is on and the
 * permissions of whoever is asking - JAM does not carry a copy of that model,
 * and the field-context APIs that would let it try need administrator rights
 * most tokens do not have. So the question is put to Jira in the form it can
 * answer exactly: on this issue, for this account, what is editable and how.
 *
 * The same shape as the other read-shaped ports, for the same reasons: it
 * mutates nothing, so it does not belong behind the write port's no-retry
 * contract, and it answers a question about a configuration rather than about
 * an issue, so the read port's completeness semantics would mean nothing here.
 *
 * It does not retry. Its answer decides a mutation.
 */
export interface JiraEditMetadataPort {
  getEditableFields(issueKey: string): Promise<EditFieldMetadata[]>;
}
