import type { FullIssueContext, NormalizedComment } from "../../domain/context.js";
import type { IssueLink, IssueRef, LinkDirection } from "../../domain/issue.js";
import type { ProjectConfig } from "../../config/schema.js";
import { adfToText } from "./adf-to-text.js";

/**
 * Raw Jira DTOs stop here. Everything above the adapter sees domain types only,
 * so swapping REST for Rovo later cannot ripple into the application layer.
 */

type RawUser = { displayName?: string; emailAddress?: string; accountId?: string };
type RawNamed = { name?: string };
/**
 * Jira's status object. `name` is the workflow's own, localized label;
 * `statusCategory.key` is the stable value Jira publishes for machines.
 */
type RawStatus = RawNamed & { statusCategory?: { key?: string } };
/**
 * A nested issue reference, as Jira embeds it in parent, subtasks and links.
 *
 * Jira sends `id` here as well as on the top-level issue, which is what makes
 * identity on a reference free: it is already in the payload, so keeping it
 * costs no request. When a shape does not carry it, it stays absent.
 */
type RawIssueRef = {
  key?: string;
  id?: string;
  fields?: { summary?: string; status?: RawStatus };
};
type RawLink = {
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: RawIssueRef;
  outwardIssue?: RawIssueRef;
};

export type RawIssue = {
  key?: string;
  id?: string;
  fields?: Record<string, unknown>;
};

export type RawComment = {
  id?: string;
  author?: RawUser;
  created?: string;
  updated?: string;
  body?: unknown;
};

export type MappedIssue = {
  issue: FullIssueContext;
  /** Total comments Jira reports for this issue, not just the embedded page. */
  commentTotal: number;
};

export function mapIssue(raw: RawIssue, config: ProjectConfig): FullIssueContext {
  return mapIssueWithMeta(raw, config).issue;
}

export function mapIssueWithMeta(raw: RawIssue, config: ProjectConfig): MappedIssue {
  const f = (raw.fields ?? {}) as Record<string, unknown>;

  const issue: FullIssueContext = {
    key: raw.key ?? "",
    summary: str(f["summary"]) ?? "",
    status: named(f["status"]) ?? "",
    updated: str(f["updated"]) ?? "",
    labels: Array.isArray(f["labels"]) ? (f["labels"] as unknown[]).map(String) : [],
    components: Array.isArray(f["components"])
      ? (f["components"] as RawNamed[]).map((c) => c.name ?? "").filter(Boolean)
      : [],
    subtasks: Array.isArray(f["subtasks"])
      ? (f["subtasks"] as RawIssueRef[]).map(issueRef)
      : [],
    links: Array.isArray(f["issuelinks"])
      ? (f["issuelinks"] as RawLink[]).flatMap(mapLink)
      : [],
    customFields: mapCustomFields(f, config),
    comments: [],
  };

  // Jira returns `id` as a property of the issue resource, not as a field, so
  // it arrives whatever the field list says and costs nothing to keep. Set
  // only when Jira sent one: an empty string would read as an identity that
  // was looked at and found blank.
  if (raw.id) issue.issueId = raw.id;

  const statusCategory = category(f["status"]);
  if (statusCategory) issue.statusCategory = statusCategory;

  const assignee = user(f["assignee"]);
  if (assignee) issue.assignee = assignee;

  const priority = named(f["priority"]);
  if (priority) issue.priority = priority;

  const issueType = named(f["issuetype"]);
  if (issueType) issue.issueType = issueType;

  if (f["parent"]) issue.parent = issueRef(f["parent"] as RawIssueRef);

  if (f["description"] != null) {
    const description = adfToText(f["description"]);
    if (description) issue.description = description;
  }

  // Issue GET / bulkfetch embed only the first page of comments; the adapter
  // pages the rest through the dedicated comment endpoint when FULL is asked for.
  const embedded = f["comment"] as
    | { comments?: RawComment[]; total?: number }
    | undefined;
  if (embedded?.comments) {
    issue.comments = embedded.comments.map(mapComment);
  }
  const commentTotal = embedded?.total ?? issue.comments.length;

  return { issue, commentTotal };
}

export function mapComment(raw: RawComment): NormalizedComment {
  const comment: NormalizedComment = {
    id: raw.id ?? "",
    created: raw.created ?? "",
    body: adfToText(raw.body),
  };
  const author = raw.author?.displayName ?? raw.author?.emailAddress;
  if (author) comment.author = author;
  if (raw.updated && raw.updated !== raw.created) comment.updated = raw.updated;
  return comment;
}

function mapLink(raw: RawLink): IssueLink[] {
  const type = raw.type ?? {};
  const out: IssueLink[] = [];

  const add = (direction: LinkDirection, target?: RawIssueRef) => {
    if (!target?.key) return;
    const label = (direction === "outward" ? type.outward : type.inward) ?? type.name ?? "relates to";
    out.push({
      type: label,
      direction,
      issue: issueRef(target),
      blocksThisIssue: isBlocking(label, direction, type.name),
    });
  };

  add("outward", raw.outwardIssue);
  add("inward", raw.inwardIssue);
  return out;
}

/**
 * True when the linked issue stands between this issue and being startable.
 * Jira phrases this from the current issue's side, e.g. "is blocked by".
 */
function isBlocking(label: string, direction: LinkDirection, typeName?: string): boolean {
  if (/blocked by|depends on|is caused by/i.test(label)) return true;
  return direction === "inward" && /^blocks$/i.test(typeName ?? "");
}

function mapCustomFields(
  fields: Record<string, unknown>,
  config: ProjectConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const cf of config.customFields) {
    const value = fields[cf.id];
    if (value == null) continue;
    const normalized = normalizeFieldValue(value);
    if (normalized == null || normalized === "") continue;
    out[cf.name] = normalized;
  }
  return out;
}

/** Collapse Jira's option/user/ADF wrappers into something worth a token. */
export function normalizeFieldValue(value: unknown): unknown {
  if (value == null) return undefined;
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    const items = value.map(normalizeFieldValue).filter((v) => v != null && v !== "");
    return items.length ? items : undefined;
  }

  const obj = value as Record<string, unknown>;
  if (obj["type"] === "doc") return adfToText(obj);
  if (typeof obj["value"] === "string") return obj["value"];
  if (typeof obj["displayName"] === "string") return obj["displayName"];
  if (typeof obj["name"] === "string") return obj["name"];
  return obj;
}

function issueRef(raw: RawIssueRef): IssueRef {
  const ref: IssueRef = { key: raw.key ?? "" };
  if (raw.id) ref.issueId = raw.id;
  const summary = raw.fields?.summary;
  if (summary) ref.summary = summary;
  const status = raw.fields?.status?.name;
  if (status) ref.status = status;
  const statusCategory = raw.fields?.status?.statusCategory?.key;
  if (statusCategory) ref.statusCategory = statusCategory;
  return ref;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function named(v: unknown): string | undefined {
  return (v as RawNamed | undefined)?.name;
}

/**
 * Jira's status category key, or nothing.
 *
 * Nothing, specifically, rather than a guess: the alternative is matching
 * `status.name` against a list of words that mean "done", which is wrong in
 * every language a project is not configured in and wrong in English the
 * moment someone renames a status.
 */
function category(v: unknown): string | undefined {
  return (v as RawStatus | undefined)?.statusCategory?.key;
}

function user(v: unknown): string | undefined {
  const u = v as RawUser | undefined;
  return u?.displayName ?? u?.emailAddress ?? undefined;
}
