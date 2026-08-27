import type { AssigneeCandidate } from "../../domain/write.js";
import { JamError } from "../../domain/errors.js";
import type { CredentialPort } from "../../ports/credentials.port.js";
import type { JiraAssigneeResolutionPort } from "../../ports/jira-assignee-resolution.port.js";
import { JiraClient } from "./jira-client.js";

type RawUser = {
  accountId?: string;
  displayName?: string;
  active?: boolean;
  accountType?: string;
};

/** How many candidates are worth reporting back to a human. */
const SEARCH_LIMIT = 20;

/**
 * Jira Cloud REST v3 user directory, read-only.
 *
 * Two endpoints, two questions:
 *
 *  - `GET /rest/api/3/user/search?query=` - who might this name mean. Jira
 *    matches display name and, where privacy settings allow it, email. The
 *    answers are candidates.
 *  - `GET /rest/api/3/user/assignable/search?issueKey=&accountId=` - may this
 *    exact account hold this exact issue. Jira answers with the account when
 *    it may and with nothing when it may not, which is the assignability check
 *    without JAM having to interpret a permission model it does not own.
 *
 * `retry: false` on both. Their answers decide a mutation, so a
 * retried-and-stale answer is worse than a failure.
 *
 * Email is deliberately not part of the identity JAM works with. Jira's
 * privacy settings routinely blank it - most users on a real site come back
 * with `emailAddress: ""` - so resolving on it would work for some people and
 * silently fail for others on the same site.
 */
export class JiraCloudAssigneeResolutionAdapter implements JiraAssigneeResolutionPort {
  private readonly client: JiraClient;

  constructor(credentials: CredentialPort, fetchImpl?: typeof fetch) {
    this.client = fetchImpl ? new JiraClient(credentials, fetchImpl) : new JiraClient(credentials);
  }

  async searchUsers(query: string): Promise<AssigneeCandidate[]> {
    const { data } = await this.client.request<RawUser[]>({
      path: "rest/api/3/user/search",
      query: { query, maxResults: SEARCH_LIMIT },
      retry: false,
    });

    return toCandidates(data);
  }

  /**
   * `GET /rest/api/3/user?accountId=` - the exact lookup, not a search.
   *
   * Jira answers 404 when no such account exists or this token cannot see it.
   * Both mean the same thing to a caller who wanted to assign it, so both
   * become `undefined` rather than an error: "there is nobody to assign" is an
   * answer, and the policy layer is where it turns into a refusal.
   */
  async getUserByAccountId(accountId: string): Promise<AssigneeCandidate | undefined> {
    try {
      const { data } = await this.client.request<RawUser>({
        path: "rest/api/3/user",
        query: { accountId },
        retry: false,
      });
      return toCandidates([data])[0];
    } catch (err) {
      if (err instanceof JamError && err.code === "ISSUE_NOT_FOUND") return undefined;
      throw err;
    }
  }

  async isAssignable(issueKey: string, accountId: string): Promise<boolean> {
    const { data } = await this.client.request<RawUser[]>({
      path: "rest/api/3/user/assignable/search",
      query: { issueKey, accountId, maxResults: 1 },
      retry: false,
    });

    // Jira answers with the account when it is assignable and with an empty
    // list when it is not. Matching the id back is belt and braces: an answer
    // about somebody else is not an answer to the question that was asked.
    return toCandidates(data).some((u) => u.accountId === accountId);
  }
}

/**
 * Users JAM can work with, from whatever Jira sent.
 *
 * An entry with no accountId is dropped: accountId is the identity, and an
 * entry without one cannot be assigned, verified, or told apart from another.
 * App and customer accounts are dropped too - they are not people a human
 * meant to name, and offering one as a candidate invites assigning an issue to
 * an integration.
 */
function toCandidates(raw: unknown): AssigneeCandidate[] {
  if (!Array.isArray(raw)) return [];

  return (raw as RawUser[])
    .filter(
      (u): u is RawUser & { accountId: string } =>
        typeof u?.accountId === "string" &&
        (u.accountType === undefined || u.accountType === "atlassian"),
    )
    .map((u) => ({
      accountId: u.accountId,
      displayName: typeof u.displayName === "string" ? u.displayName : u.accountId,
      active: u.active !== false,
    }));
}
