import { textToAdf } from "../../domain/adf.js";
import { JamError } from "../../domain/errors.js";
import type { JiraTransition } from "../../domain/write.js";
import type { CredentialPort } from "../../ports/credentials.port.js";
import type { JiraWritePort } from "../../ports/jira-write.port.js";
import { JiraClient } from "./jira-client.js";

type RawTransition = {
  id?: string;
  name?: string;
  to?: { name?: string };
};

/**
 * Jira Cloud REST v3, mutating half.
 *
 * Every request here sets `retry: false`. The read adapter's retry loop is
 * correct for reads and dangerous here: a request that times out after Jira
 * accepted it is indistinguishable from one Jira never saw, and resending it
 * duplicates the change. The application layer resolves that by reading the
 * issue back - see applyWritePlan.
 *
 * This adapter also never reads its own work. Confirmation is a direct issue
 * GET through the read port, which keeps "what JAM did" and "what Jira shows"
 * two separate observations rather than one hopeful one.
 */
export class JiraCloudWriteAdapter implements JiraWritePort {
  private readonly client: JiraClient;

  constructor(credentials: CredentialPort, fetchImpl?: typeof fetch) {
    this.client = fetchImpl
      ? new JiraClient(credentials, fetchImpl)
      : new JiraClient(credentials);
  }

  /**
   * Create one issue, once.
   *
   * `retry: false` matters more here than anywhere else behind this port. A
   * retried update converges; a retried create leaves two issues, and the
   * second one has a different key nobody is holding. An ambiguous failure is
   * handed to the application layer as JAM_WRITE_UNCERTAIN and resolved by
   * looking, never by sending it again.
   */
  async createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string }> {
    const { data } = await this.client.request<{ id?: string; key?: string }>({
      path: "rest/api/3/issue",
      method: "POST",
      body: { fields },
      retry: false,
    });

    if (!data?.key || !data.id) {
      // Jira took the request and told us nothing identifying, so an issue may
      // now exist that JAM cannot name. That is exactly the uncertain case:
      // report it, do not retry, and let a person look.
      throw new JamError(
        "JAM_WRITE_UNCERTAIN",
        "Jira accepted a create but returned no issue key, so JAM cannot tell which issue it made - or whether it made one. Look in the project before trying again: retrying could create a second issue.",
        { project: (fields["project"] as { key?: string } | undefined)?.key },
      );
    }
    return { id: data.id, key: data.key };
  }

  async updateIssue(key: string, fields: Record<string, unknown>): Promise<void> {
    await this.client.request<void>({
      path: `rest/api/3/issue/${encodeURIComponent(key)}`,
      method: "PUT",
      body: { fields },
      retry: false,
    });
  }

  /**
   * Add a comment, converting plain text to ADF here rather than accepting ADF.
   *
   * Jira's comment body is a document tree, and letting an agent supply one
   * would mean accepting arbitrary structure - panels, mentions, embedded
   * content - through a field that reads like "text". The conversion is narrow
   * on purpose: paragraphs, and nothing else.
   */
  async addComment(key: string, body: string): Promise<{ id: string }> {
    const { data } = await this.client.request<{ id?: string }>({
      path: `rest/api/3/issue/${encodeURIComponent(key)}/comment`,
      method: "POST",
      body: { body: textToAdf(body) },
      retry: false,
    });

    if (!data?.id) {
      // Jira accepted it but told us nothing identifying. Treat that as
      // unconfirmed rather than inventing an id: the caller's direct read is
      // what decides whether the comment exists.
      throw new JamError(
        "JAM_WRITE_UNCERTAIN",
        `Jira accepted a comment on ${key} but returned no comment id, so JAM cannot confirm which comment it created.`,
        { issueKey: key },
      );
    }
    return { id: data.id };
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const { data } = await this.client.request<{ transitions?: RawTransition[] }>({
      path: `rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      // A read, but on the write path: its answer decides a mutation, so a
      // retried-and-stale transition list would be worse than a failure.
      retry: false,
    });

    return (data.transitions ?? [])
      .filter((t): t is RawTransition & { id: string } => typeof t.id === "string")
      .map((t) => ({
        id: t.id,
        name: t.name ?? t.id,
        to: t.to?.name ?? t.name ?? "",
      }));
  }

  /**
   * `PUT /rest/api/3/issue/{key}/assignee` with an accountId.
   *
   * The dedicated assignment endpoint rather than a field update: assignment
   * has its own permission and its own Jira semantics, and routing it through
   * the generic field PUT would put it behind the field whitelist, where it
   * does not belong.
   */
  async assignIssue(key: string, accountId: string): Promise<void> {
    await this.client.request<void>({
      path: `rest/api/3/issue/${encodeURIComponent(key)}/assignee`,
      method: "PUT",
      body: { accountId },
      retry: false,
    });
  }

  async transitionIssue(key: string, transitionId: string): Promise<void> {
    await this.client.request<void>({
      path: `rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      method: "POST",
      body: { transition: { id: transitionId } },
      retry: false,
    });
  }
}
