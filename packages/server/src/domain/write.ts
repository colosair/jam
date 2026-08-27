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

/**
 * Operations that change an issue that already exists.
 *
 * Kept apart from creation because the two have different shapes at every
 * layer: these name an issue, creation names a project; these compare a
 * revision to detect a conflict, creation has no revision to compare.
 */
export const EXISTING_ISSUE_OPERATIONS = [
  "comment.add",
  "field.update",
  "status.transition",
  "assignee.update",
  "custom-field.update",
] as const;

/** The operations the public MCP surface accepts. Nothing else is reachable. */
export const WRITE_OPERATIONS = [...EXISTING_ISSUE_OPERATIONS, "issue.create"] as const;

export type ExistingIssueOperation = (typeof EXISTING_ISSUE_OPERATIONS)[number];
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

/**
 * Who to assign an issue to, as a person would say it.
 *
 * A display name, or an accountId if the caller already has one. Either way it
 * is a selector, not an identifier: nothing here is ever sent to Jira. It is
 * resolved against Jira's own user directory first, and what gets written is
 * the accountId that resolution produced.
 */
export type AssigneeUpdateInput = { assignee: string };

/**
 * A Jira user as JAM identifies them.
 *
 * `accountId` is the identity; `displayName` is for the human reading the
 * receipt. They are not interchangeable - two people can share a display name,
 * which is precisely why an assignment is verified on the accountId.
 */
export type AssigneeRef = {
  accountId: string;
  displayName: string;
};

/** A user Jira offered in answer to a search. */
export type AssigneeCandidate = AssigneeRef & {
  active: boolean;
};

/**
 * Fields `issue.create` may set.
 *
 * The same argument as WRITABLE_FIELDS, and the same answer: a closed list, so
 * "what can an agent create" has an answer that does not depend on one
 * project's screen configuration. `issueType` and `summary` are required by
 * every Jira project JAM can serve; the rest are optional and only sent when
 * asked for.
 */
export const CREATABLE_FIELDS = [
  "issueType",
  "summary",
  "description",
  "priority",
  "labels",
  "components",
] as const;

export type CreatableField = (typeof CREATABLE_FIELDS)[number];

export type CreateIssueInput = {
  issueType: string;
  summary: string;
  description?: string;
  priority?: string;
  labels?: string[];
  components?: string[];
};

export type WriteInput =
  | CommentAddInput
  | FieldUpdateInput
  | StatusTransitionInput
  | AssigneeUpdateInput
  | CustomFieldUpdateInput
  | CreateIssueInput;

/** An issue type as Jira offers it for one project, right now. */
export type CreateIssueType = {
  id: string;
  name: string;
  subtask: boolean;
};

/**
 * One field on a project's create screen, as Jira describes it.
 *
 * `allowedValues` is present only for fields Jira constrains (priority,
 * components, and issue-type-scoped pickers). Absent means unconstrained, not
 * empty - the difference decides whether a value can be resolved or must be
 * refused.
 */
export type CreateFieldMetadata = {
  /** Jira's field id, e.g. `summary` or `customfield_12345`. */
  id: string;
  name: string;
  required: boolean;
  hasDefaultValue: boolean;
  allowedValues?: { id?: string; name?: string }[];
};

/**
 * What a create plan depends on, recorded so apply can check it again.
 *
 * Not a hash of the metadata document: an unrelated optional field appearing
 * on the create screen does not invalidate a plan, and treating it as though
 * it did would make every plan fail on a busy project. What is recorded here
 * is the set of premises the plan was built on, and apply re-derives whether
 * each still holds.
 */
export type CreateSchemaRequirements = {
  issueTypeId: string;
  issueTypeName: string;
  /** Required field ids JAM undertook to supply or knew Jira would default. */
  requiredFieldIds: string[];
  /**
   * Values resolved from Jira's allowed lists at plan time, by field id. Apply
   * refuses if any of them is no longer offered.
   */
  resolvedValues: { fieldId: string; requested: string; resolved: string }[];
};

/**
 * One field on an issue's edit screen, as Jira describes it.
 *
 * Normalized at the adapter: `operations` and `schema` come straight from
 * Jira's own vocabulary because they are the vocabulary the decision is made
 * in, but nothing else of the raw document travels.
 */
export type EditFieldMetadata = {
  /** Jira's field id, e.g. `customfield_10021`. */
  id: string;
  name: string;
  required: boolean;
  /** What Jira says can be done to this field: `set`, `add`, `remove`, ... */
  operations: string[];
  schema: {
    type: string;
    /** Element type, for `type: "array"`. */
    items?: string;
    /** The custom field's implementation key, when it is a custom field. */
    custom?: string;
    customId?: number;
  };
  /** Present only where Jira constrains the value. Absent is not empty. */
  allowedValues?: EditFieldOption[];
};

/**
 * One option Jira offers for a constrained field.
 *
 * `id` is the identity and `label` is what a person reads - the same split as
 * a user's accountId and display name, and for the same reason: an option can
 * be renamed without becoming a different option, and two options could carry
 * the same label.
 */
export type EditFieldOption = {
  id: string;
  label: string;
};

/**
 * The custom field value families JAM can write.
 *
 * Narrow on purpose. Each of these has an unambiguous wire shape that JAM can
 * produce from a plain caller value and compare after the fact. Everything
 * else - dates needing a timezone policy, rich text needing ADF, user and
 * group pickers needing identity resolution, app-owned fields with private
 * semantics - is refused rather than guessed at.
 */
export const CUSTOM_FIELD_KINDS = ["text", "number", "single-option", "multi-option"] as const;

export type CustomFieldKind = (typeof CUSTOM_FIELD_KINDS)[number];

export type CustomFieldUpdateInput = {
  /** A configured field id, or a configured writable field name. */
  field: string;
  value: string | number | string[];
};

/**
 * What a custom-field plan depends on, recorded so apply can check it again.
 *
 * The issue's revision does not cover any of this: a field can be taken off a
 * screen, lose its `set` operation, change type, or have an option renamed
 * without the issue itself being touched. So these premises are frozen
 * alongside `baseUpdated`, and re-derived before the write.
 */
export type CustomFieldRequirements = {
  fieldId: string;
  fieldName: string;
  kind: CustomFieldKind;
  schema: { type: string; items?: string; custom?: string };
  /** Options resolved from Jira's allowed list, for the option kinds. */
  resolvedOptions?: EditFieldOption[];
};

/** A custom field value as a receipt shows it - reviewable, not a Jira payload. */
export type CustomFieldValueView =
  | { id: string; name: string; value: string | number | null }
  | { id: string; name: string; value: EditFieldOption | null }
  | { id: string; name: string; value: EditFieldOption[] };

/** A transition as Jira currently offers it for one issue. */
export type JiraTransition = {
  id: string;
  name: string;
  /** The status this transition leads to, as Jira names it. */
  to: string;
};

/** Fields every plan carries, whatever it is a plan for. */
type WritePlanCommon = {
  planId: string;
  projectKey: string;
  /** Only the fields this operation touches. */
  before: Record<string, unknown>;
  intendedAfter: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  /** Normalized payload the apply step will send. Never supplied by a caller. */
  mutation: WriteMutation;
};

/**
 * A plan against an issue that already exists.
 *
 * `baseUpdated` is the issue's `updated` timestamp at plan time. Apply re-reads
 * the issue and refuses when it has moved: a plan that was valid is not the
 * same as a plan that is still valid.
 */
export type ExistingIssueWritePlan = WritePlanCommon & {
  kind: "existing-issue";
  issueKey: string;
  operation: ExistingIssueOperation;
  baseUpdated: string;
  /**
   * The transition Jira offered for this target status, resolved at plan time.
   * Present only for `status.transition` - a transition id is never guessed
   * from a status name.
   */
  transition?: JiraTransition;
  /**
   * Who the issue was assigned to when the plan was made, by identity.
   *
   * Present only for `assignee.update`, and separate from `before` because
   * `before` is what a receipt shows a human while this is what apply compares.
   * `undefined` means the issue was unassigned.
   */
  baseAssigneeAccountId?: string;
  /**
   * What this plan assumed about a custom field's configuration. Present only
   * for `custom-field.update`; apply re-derives each premise before writing.
   */
  customFieldRequirements?: CustomFieldRequirements;
};

/**
 * A plan to create an issue that does not exist yet.
 *
 * There is no `issueKey` and no `baseUpdated`, and neither is filled with a
 * placeholder: nothing to name, and no revision to compare. What takes their
 * place is `schemaRequirements` - creation's concurrency boundary is the
 * project's create schema, not one issue's revision, so that is what apply
 * re-checks before it sends anything.
 */
export type CreateIssueWritePlan = WritePlanCommon & {
  kind: "create-issue";
  operation: "issue.create";
  before: { issue: null };
  schemaRequirements: CreateSchemaRequirements;
};

export type WritePlan = ExistingIssueWritePlan | CreateIssueWritePlan;

/** A plan as it is handed to the store, before an id has been minted. */
export type NewWritePlan =
  | Omit<ExistingIssueWritePlan, "planId">
  | Omit<CreateIssueWritePlan, "planId">;

/** What apply will actually send. Produced by planning, never by an agent. */
export type WriteMutation =
  | { kind: "comment"; text: string }
  | { kind: "fields"; fields: Record<string, unknown> }
  | { kind: "transition"; transitionId: string }
  | { kind: "assignee"; accountId: string }
  | { kind: "custom-field"; fieldId: string; value: unknown }
  | { kind: "create"; fields: Record<string, unknown> };

/** What `jira_write_plan` returns. The mutation itself is not exposed. */
export type WritePlanReceipt = {
  status: "planned";
  planId: string;
  operation: WriteOperation;
  before: Record<string, unknown>;
  intendedAfter: Record<string, unknown>;
  expiresAt: string;
  /**
   * The issue this plan changes. Absent for `issue.create`, which has no issue
   * yet - a placeholder key here would be a claim JAM cannot make.
   */
  issue?: string;
  /** The project a new issue would be created in. Present for `issue.create`. */
  project?: string;
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
  /** For `issue.create`, the key Jira minted - known only after applying. */
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

export function isExistingIssueOperation(value: string): value is ExistingIssueOperation {
  return (EXISTING_ISSUE_OPERATIONS as readonly string[]).includes(value);
}

export function isWritableField(value: string): value is WritableField {
  return (WRITABLE_FIELDS as readonly string[]).includes(value);
}
