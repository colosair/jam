import type { JiraTransition } from "../domain/write.js";

/**
 * The mutating half of Jira, kept apart from reading on purpose.
 *
 * Two rules govern everything behind this port:
 *
 *  - A write is not confirmed by its own HTTP response. ConsistencyPolicy
 *    requires a direct issue GET afterwards, which is the read port's job -
 *    this port never reads back its own work.
 *  - Nothing here retries. A read that times out can be repeated; a POST that
 *    times out may already have been applied, and repeating it is how one
 *    comment becomes two. Ambiguity is resolved by looking, not by trying
 *    again.
 *
 * The field map is generic at this layer because Jira's is. The public MCP
 * surface is not: only whitelisted operations reach it (see domain/write.ts).
 */
export interface JiraWritePort {
  /**
   * Create one issue. The only call here that brings an issue into existence,
   * and the one where a retry is most expensive: a duplicate update is a
   * no-op, a duplicate create is a second issue on someone's board.
   */
  createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string }>;
  updateIssue(key: string, fields: Record<string, unknown>): Promise<void>;
  addComment(key: string, body: string): Promise<{ id: string }>;
  /** Transitions Jira offers for this issue right now, for this account. */
  getTransitions(key: string): Promise<JiraTransition[]>;
  transitionIssue(key: string, transitionId: string): Promise<void>;
}
