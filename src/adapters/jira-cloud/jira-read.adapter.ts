import type { ProjectConfig } from "../../config/schema.js";
import type { CredentialPort } from "../../ports/credentials.port.js";
import type {
  CurrentUser,
  GetCommentsRequest,
  GetCommentsResult,
  GetIssuesRequest,
  GetIssuesResult,
  JiraReadPort,
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
