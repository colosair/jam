import type { ProjectConfig } from "../../config/schema.js";
import type { CredentialPort } from "../../ports/credentials.port.js";
import type {
  CurrentUser,
  GetCommentsRequest,
  GetCommentsResult,
  GetIssueRequest,
  GetIssueResult,
  GetIssuesRequest,
  GetIssuesResult,
  JiraReadPort,
  ListProjectsResult,
  SearchPageRequest,
  SearchPageResult,
} from "../../ports/jira-read.port.js";
import { JiraClient } from "./jira-client.js";
import { mapComment, mapIssueWithMeta, type RawComment, type RawIssue } from "./mapper.js";

/** Jira Cloud caps a bulkfetch request at 100 keys. */
const BULK_CHUNK = 100;

export class JiraCloudReadAdapter implements JiraReadPort {
  private readonly client: JiraClient;

  constructor(
    credentials: CredentialPort,
    private readonly config: ProjectConfig,
    fetchImpl?: typeof fetch,
  ) {
    this.client = new JiraClient(credentials, fetchImpl);
  }

  async searchPage(req: SearchPageRequest): Promise<SearchPageResult> {
    const { data, bytes } = await this.client.request<{
      issues?: RawIssue[];
      nextPageToken?: string;
    }>({
      path: "rest/api/3/search/jql",
      query: {
        jql: req.jql,
        fields: req.fields.join(","),
        maxResults: req.pageSize,
        nextPageToken: req.pageToken,
      },
    });

    const result: SearchPageResult = {
      issues: (data.issues ?? []).map((raw) => mapIssueWithMeta(raw, this.config).issue),
      responseBytes: bytes,
    };
    if (data.nextPageToken) result.nextPageToken = data.nextPageToken;
    return result;
  }

  /**
   * `GET /rest/api/3/issue/{key}` - the single-issue endpoint, not bulkfetch.
   *
   * This is what ConsistencyPolicy means by a direct issue read, and the write
   * plane is the only caller. A 404 is an answer, not a failure: the issue is
   * not there, or not visible to this account, and the caller decides which of
   * those matters.
   */
  async getIssue(req: GetIssueRequest): Promise<GetIssueResult> {
    const { data, bytes } = await this.client.request<RawIssue>({
      path: `rest/api/3/issue/${encodeURIComponent(req.key)}`,
      query: { fields: req.fields.join(",") },
    });

    if (!data?.key) return { responseBytes: bytes };
    return { issue: mapIssueWithMeta(data, this.config).issue, responseBytes: bytes };
  }

  async getIssues(req: GetIssuesRequest): Promise<GetIssuesResult> {
    const issues: GetIssuesResult["issues"] = [];
    const commentTotals: Record<string, number> = {};
    let responseBytes = 0;
    const returned = new Set<string>();

    for (const chunk of chunks(req.keys, BULK_CHUNK)) {
      const { data, bytes } = await this.client.request<{ issues?: RawIssue[] }>({
        path: "rest/api/3/issue/bulkfetch",
        method: "POST",
        body: {
          issueIdsOrKeys: chunk,
          fields: req.fields,
          fieldsByKeys: true,
        },
      });
      responseBytes += bytes;
      for (const raw of data.issues ?? []) {
        const { issue, commentTotal } = mapIssueWithMeta(raw, this.config);
        issues.push(issue);
        commentTotals[issue.key] = commentTotal;
        returned.add(issue.key.toUpperCase());
      }
    }

    // bulkfetch reports unreadable keys in `issueErrors`, but a key can also be
    // silently absent. Diffing requested against returned catches both.
    const missingKeys = req.keys.filter((k) => !returned.has(k.toUpperCase()));

    return { issues, missingKeys, commentTotals, responseBytes };
  }

  async getComments(req: GetCommentsRequest): Promise<GetCommentsResult> {
    const { data, bytes } = await this.client.request<{
      comments?: RawComment[];
      startAt?: number;
      total?: number;
    }>({
      path: `rest/api/3/issue/${encodeURIComponent(req.key)}/comment`,
      query: {
        startAt: req.startAt,
        maxResults: req.maxResults,
        orderBy: "created",
      },
    });

    return {
      comments: (data.comments ?? []).map(mapComment),
      startAt: data.startAt ?? req.startAt,
      total: data.total ?? 0,
      responseBytes: bytes,
    };
  }

  async listProjects(): Promise<ListProjectsResult> {
    const { data } = await this.client.request<{
      isLast?: boolean;
      values?: { key?: string; name?: string }[];
    }>({ path: "rest/api/3/project/search", query: { maxResults: 50 } });

    return {
      projects: (data.values ?? [])
        .filter((p): p is { key: string; name: string } => Boolean(p.key && p.name))
        .map((p) => ({ key: p.key, name: p.name })),
      truncated: data.isLast === false,
    };
  }

  async getCurrentUser(): Promise<CurrentUser> {
    const { data } = await this.client.request<{
      accountId?: string;
      displayName?: string;
      emailAddress?: string;
    }>({ path: "rest/api/3/myself" });

    const user: CurrentUser = { accountId: data.accountId ?? "" };
    if (data.displayName) user.displayName = data.displayName;
    if (data.emailAddress) user.emailAddress = data.emailAddress;
    return user;
  }
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
