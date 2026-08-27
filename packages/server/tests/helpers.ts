import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
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
import type { JiraWritePort } from "../src/ports/jira-write.port.js";
import type { JiraCreateMetadataPort } from "../src/ports/jira-create-metadata.port.js";
import type {
  CreateFieldMetadata,
  CreateIssueType,
  JiraTransition,
} from "../src/domain/write.js";
import { WritePlanStore } from "../src/application/write-plan-store.js";
import type { FullIssueContext } from "../src/domain/context.js";

/**
 * Recursive snapshot of a directory tree: relative path -> contents.
 *
 * Shared because "this command changed nothing" is asserted from several
 * angles - a plan that must not mutate, a serve that must not write - and the
 * comparison has to mean the same thing in all of them.
 */
export function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[relative(root, full)] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}

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

export function testDeps(
  jira: JiraReadPort,
  config: ProjectConfig = testConfig(),
  jiraWrite: JiraWritePort = new UnreachableJiraWrite(),
  writePlans: WritePlanStore = new WritePlanStore(),
  jiraCreateMetadata: JiraCreateMetadataPort = new UnreachableCreateMetadata(),
): JamDeps {
  return {
    config,
    jira,
    jiraWrite,
    jiraCreateMetadata,
    writePlans,
    cache: new NoopCache(),
    telemetry: new RecordingTelemetry(),
    credentials: new FakeCredentials(),
  };
}

/**
 * The default write port for tests that are not about writing.
 *
 * Throws rather than no-ops: a read test that somehow reaches a write should
 * fail loudly, not silently pass having mutated nothing.
 */
export class UnreachableJiraWrite implements JiraWritePort {
  async createIssue(): Promise<{ id: string; key: string }> {
    throw new Error("test reached the write port unexpectedly");
  }
  async updateIssue(): Promise<void> {
    throw new Error("test reached the write port unexpectedly");
  }
  async addComment(): Promise<{ id: string }> {
    throw new Error("test reached the write port unexpectedly");
  }
  async getTransitions(): Promise<JiraTransition[]> {
    throw new Error("test reached the write port unexpectedly");
  }
  async transitionIssue(): Promise<void> {
    throw new Error("test reached the write port unexpectedly");
  }
}

/**
 * A write port that records what it was asked to do and answers from a script.
 *
 * Every write test drives this rather than a real adapter - nothing in the
 * suite may reach a Jira write endpoint, and "did JAM call this once, with
 * exactly this" is most of what the write tests assert.
 */
export class FakeJiraWrite implements JiraWritePort {
  readonly updates: { key: string; fields: Record<string, unknown> }[] = [];
  readonly comments: { key: string; body: string }[] = [];
  readonly transitionCalls: { key: string; transitionId: string }[] = [];
  readonly creates: Record<string, unknown>[] = [];
  /**
   * How many times createIssue was entered, including calls that then failed.
   * `creates` records only the ones that got as far as Jira accepting them, so
   * proving "sent exactly once, even when it blew up" needs this counter.
   */
  createCalls = 0;
  transitions: JiraTransition[] = [];
  /** The key the next create returns. Absent means Jira named nothing. */
  createdKey?: string = "PROJECT-500";
  /** Thrown by the next mutating call, once. */
  failNext?: Error;

  constructor(options: { transitions?: JiraTransition[] } = {}) {
    if (options.transitions) this.transitions = options.transitions;
  }

  private throwIfArmed(): void {
    const err = this.failNext;
    if (!err) return;
    this.failNext = undefined as unknown as Error;
    throw err;
  }

  async createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string }> {
    this.createCalls += 1;
    this.throwIfArmed();
    this.creates.push(fields);
    if (!this.createdKey) {
      throw new Error("Jira accepted a create but returned no key");
    }
    return { id: "10500", key: this.createdKey };
  }

  async updateIssue(key: string, fields: Record<string, unknown>): Promise<void> {
    this.throwIfArmed();
    this.updates.push({ key, fields });
  }

  async addComment(key: string, body: string): Promise<{ id: string }> {
    this.throwIfArmed();
    this.comments.push({ key, body });
    return { id: `comment-${this.comments.length}` };
  }

  async getTransitions(): Promise<JiraTransition[]> {
    return this.transitions;
  }

  async transitionIssue(key: string, transitionId: string): Promise<void> {
    this.throwIfArmed();
    this.transitionCalls.push({ key, transitionId });
  }

  /** Every mutating call, in order - used to prove nothing was retried. */
  get mutations(): number {
    return (
      this.updates.length + this.comments.length + this.transitionCalls.length + this.creates.length
    );
  }
}

/**
 * The default create-metadata port, for tests that are not about creating.
 *
 * Throws, like UnreachableJiraWrite: reaching Jira's create schema from a test
 * that never meant to should fail loudly rather than quietly answer nothing.
 */
export class UnreachableCreateMetadata implements JiraCreateMetadataPort {
  async getIssueTypes(): Promise<CreateIssueType[]> {
    throw new Error("test reached the create metadata port unexpectedly");
  }
  async getCreateFields(): Promise<CreateFieldMetadata[]> {
    throw new Error("test reached the create metadata port unexpectedly");
  }
}

/**
 * A create schema served from a fixture, and a record of what was asked.
 *
 * `issueTypes` and `fields` are mutable so a test can change the answer
 * between plan and apply - which is the whole of the schema-revalidation
 * story, and cannot be told with a frozen fixture.
 */
export class FakeCreateMetadata implements JiraCreateMetadataPort {
  issueTypes: CreateIssueType[];
  fields: CreateFieldMetadata[];
  readonly issueTypeCalls: string[] = [];
  readonly fieldCalls: { projectKey: string; issueTypeId: string }[] = [];

  constructor(
    options: { issueTypes?: CreateIssueType[]; fields?: CreateFieldMetadata[] } = {},
  ) {
    this.issueTypes = options.issueTypes ?? [
      { id: "10001", name: "Task", subtask: false },
      { id: "10002", name: "Bug", subtask: false },
      { id: "10003", name: "Subtask", subtask: true },
    ];
    this.fields = options.fields ?? [
      { id: "summary", name: "Summary", required: true, hasDefaultValue: false },
      { id: "issuetype", name: "Issue Type", required: true, hasDefaultValue: false },
      { id: "description", name: "Description", required: false, hasDefaultValue: false },
      {
        id: "priority",
        name: "Priority",
        required: false,
        hasDefaultValue: true,
        allowedValues: [{ id: "1", name: "High" }, { id: "2", name: "Medium" }, { id: "3", name: "Low" }],
      },
      { id: "labels", name: "Labels", required: false, hasDefaultValue: false },
      {
        id: "components",
        name: "Components",
        required: false,
        hasDefaultValue: false,
        allowedValues: [{ id: "100", name: "Backend" }, { id: "101", name: "Frontend" }],
      },
    ];
  }

  async getIssueTypes(projectKey: string): Promise<CreateIssueType[]> {
    this.issueTypeCalls.push(projectKey);
    return this.issueTypes;
  }

  async getCreateFields(projectKey: string, issueTypeId: string): Promise<CreateFieldMetadata[]> {
    this.fieldCalls.push({ projectKey, issueTypeId });
    return this.fields;
  }
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
