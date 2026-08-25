import type { JamDeps } from "../src/deps.js";
import { ProjectConfigSchema, type ProjectConfig } from "../src/config/schema.js";
import { NoopCache } from "../src/adapters/cache/noop-cache.js";
import type { CredentialPort } from "../src/ports/credentials.port.js";
import type {
  GetCommentsRequest,
  GetCommentsResult,
  GetIssuesRequest,
  GetIssuesResult,
  JiraReadPort,
  ListProjectsResult,
  SearchPageRequest,
  SearchPageResult,
} from "../src/ports/jira-read.port.js";
import type { TelemetryPort, ToolMetrics } from "../src/ports/telemetry.port.js";
import type { FullIssueContext } from "../src/domain/context.js";

export function testConfig(overrides: Record<string, unknown> = {}): ProjectConfig {
  return ProjectConfigSchema.parse({ project: { key: "PROJECT" }, ...overrides });
}

export class RecordingTelemetry implements TelemetryPort {
  readonly records: ToolMetrics[] = [];
  recordTool(m: ToolMetrics): void {
    this.records.push(m);
  }
}

export class FakeCredentials implements CredentialPort {
  load() {
    return {
      baseUrl: "https://example.atlassian.net",
      email: "user@example.com",
      apiToken: "SUPER_SECRET_TOKEN",
    };
  }
  describe() {
    return {
      baseUrl: "https://example.atlassian.net",
      email: "user@example.com",
      hasToken: true,
      source: "process" as const,
    };
  }
}

export type FakeJiraOptions = {
  pages?: SearchPageResult[];
  issues?: FullIssueContext[];
  missingKeys?: string[];
  commentTotals?: Record<string, number>;
  commentPages?: Record<string, GetCommentsResult[]>;
  projects?: ListProjectsResult;
};

/** In-memory JiraReadPort so pagination and completeness can be tested exactly. */
export class FakeJira implements JiraReadPort {
  readonly searchCalls: SearchPageRequest[] = [];
  readonly issueCalls: GetIssuesRequest[] = [];
  readonly commentCalls: GetCommentsRequest[] = [];
  private commentCursor: Record<string, number> = {};

  constructor(private readonly options: FakeJiraOptions = {}) {}

  async searchPage(req: SearchPageRequest): Promise<SearchPageResult> {
    this.searchCalls.push(req);
    const pages = this.options.pages ?? [];
    const index = this.searchCalls.length - 1;
    return pages[index] ?? { issues: [], responseBytes: 0 };
  }

  async getIssues(req: GetIssuesRequest): Promise<GetIssuesResult> {
    this.issueCalls.push(req);
    const issues = (this.options.issues ?? []).map((i) => ({ ...i, comments: [...i.comments] }));
    return {
      issues,
      missingKeys: this.options.missingKeys ?? [],
      commentTotals:
        this.options.commentTotals ??
        Object.fromEntries(issues.map((i) => [i.key, i.comments.length])),
      responseBytes: 100,
    };
  }

  async getComments(req: GetCommentsRequest): Promise<GetCommentsResult> {
    this.commentCalls.push(req);
    const pages = this.options.commentPages?.[req.key] ?? [];
    const cursor = this.commentCursor[req.key] ?? 0;
    this.commentCursor[req.key] = cursor + 1;
    return pages[cursor] ?? { comments: [], startAt: req.startAt, total: 0, responseBytes: 0 };
  }

  async getCurrentUser() {
    return { accountId: "acc-1", displayName: "Test User" };
  }

  async listProjects(): Promise<ListProjectsResult> {
    return this.options.projects ?? { projects: [], truncated: false };
  }
}

export function testDeps(jira: JiraReadPort, config: ProjectConfig = testConfig()): JamDeps {
  return {
    config,
    jira,
    cache: new NoopCache(),
    telemetry: new RecordingTelemetry(),
    credentials: new FakeCredentials(),
  };
}

export function issue(partial: Partial<FullIssueContext> & { key: string }): FullIssueContext {
  return {
    summary: `Summary for ${partial.key}`,
    status: "Open",
    updated: "2026-08-25T12:00:00.000+0900",
    labels: [],
    components: [],
    subtasks: [],
    links: [],
    customFields: {},
    comments: [],
    ...partial,
  };
}
