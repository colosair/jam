/**
 * The write contract.
 *
 * JAM's write plane is not a Jira REST proxy. An agent cannot hand JAM a
 * mutation and have it forwarded; it describes an intent, JAM works out whether
 * that intent is currently possible, and only a plan JAM itself produced can be
 * applied. Everything in this file exists to keep that shape: a closed set of
 * operations, a fixed field whitelist, and a plan that records what the issue
 * looked like when the plan was made.
 *
 * Read semantics are deliberately not reused here. A read result's `meta`
 * answers "how complete was this retrieval"; a write result answers "did this
 * change happen, and did we see it happen". Mixing them would let a confident
 * `complete: true` stand in for a verified mutation.
 */

/** The operations the public MCP surface accepts. Nothing else is reachable. */
export const WRITE_OPERATIONS = ["comment.add", "field.update", "status.transition"] as const;

export type WriteOperation = (typeof WRITE_OPERATIONS)[number];

/**
 * Fields `field.update` may touch.
 *
 * A whitelist rather than an open field map: an open map turns every
 * project-specific screen, custom field and permission quirk into a runtime
 * surprise, and makes "what can an agent change" unanswerable. Custom fields
 * and assignee are deliberately absent - both need resolution work (schema
 * discovery, accountId lookup) that belongs in its own round.
 */
export const WRITABLE_FIELDS = ["summary", "priority", "labels", "components"] as const;

export type WritableField = (typeof WRITABLE_FIELDS)[number];

export type CommentAddInput = { text: string };

export type FieldUpdateInput = {
  summary?: string;
  priority?: string;
  labels?: string[];
  components?: string[];
};

export type StatusTransitionInput = { status: string };

export type WriteInput = CommentAddInput | FieldUpdateInput | StatusTransitionInput;

/** A transition as Jira currently offers it for one issue. */
export type JiraTransition = {
  id: string;
  name: string;
  /** The status this transition leads to, as Jira names it. */
  to: string;
};

/**
 * What a plan captured, and what it intends.
 *
 * `baseUpdated` is the issue's `updated` timestamp at plan time. Apply re-reads
 * the issue and refuses when it has moved: a plan that was valid is not the
 * same as a plan that is still valid.
 */
export type WritePlan = {
  planId: string;
  issueKey: string;
  projectKey: string;
  operation: WriteOperation;
  /** Only the fields this operation touches. */
  before: Record<string, unknown>;
  intendedAfter: Record<string, unknown>;
  baseUpdated: string;
  createdAt: string;
  expiresAt: string;
  /**
   * The transition Jira offered for this target status, resolved at plan time.
   * Present only for `status.transition` - a transition id is never guessed
   * from a status name.
   */
  transition?: JiraTransition;
  /** Normalized payload the apply step will send. Never supplied by a caller. */
  mutation: WriteMutation;
};

/** What apply will actually send. Produced by planning, never by an agent. */
export type WriteMutation =
  | { kind: "comment"; text: string }
  | { kind: "fields"; fields: Record<string, unknown> }
  | { kind: "transition"; transitionId: string };

/** What `jira_write_plan` returns. The mutation itself is not exposed. */
export type WritePlanReceipt = {
  status: "planned";
  planId: string;
  issue: string;
  operation: WriteOperation;
  before: Record<string, unknown>;
  intendedAfter: Record<string, unknown>;
  expiresAt: string;
  /** How the result of applying this plan will be confirmed. */
  verification: {
    method: "direct-issue-read";
    /** What a direct read must show before JAM calls the write applied. */
    expects: Record<string, unknown>;
  };
};

/** What `jira_write_apply` returns once a direct read has confirmed the change. */
export type WriteApplyReceipt = {
  status: "applied";
  issue: string;
  operation: WriteOperation;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** Always true in an `applied` receipt - an unverified write is an error. */
  verified: true;
  /** Present for `comment.add`: the comment Jira created. */
  commentId?: string;
};

export function isWriteOperation(value: string): value is WriteOperation {
  return (WRITE_OPERATIONS as readonly string[]).includes(value);
}

export function isWritableField(value: string): value is WritableField {
  return (WRITABLE_FIELDS as readonly string[]).includes(value);
}
