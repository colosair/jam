/**
 * Write path is out of scope for the first release - the structural boundary
 * exists so adding writes later does not reshape the application layer.
 * See ConsistencyPolicy: a write must be confirmed with a direct issue GET,
 * never with a JQL search result.
 */
export interface JiraWritePort {
  updateIssue(key: string, fields: Record<string, unknown>): Promise<void>;
  addComment(key: string, body: string): Promise<{ id: string }>;
}
