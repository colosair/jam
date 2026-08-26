import { JamError } from "../domain/errors.js";
import {
  isWritableField,
  isWriteOperation,
  WRITABLE_FIELDS,
  WRITE_OPERATIONS,
  type FieldUpdateInput,
  type JiraTransition,
  type WriteOperation,
} from "../domain/write.js";

/**
 * What a write is allowed to be, decided before anything reaches Jira.
 *
 * These checks exist so a refusal is a JAM answer rather than a Jira 403 or a
 * 404 with no explanation. "You asked to change an issue in another project"
 * and "Jira says that issue does not exist" look identical from the REST layer
 * and mean entirely different things to whoever has to act next.
 */

/**
 * How long a plan stays applicable.
 *
 * Short on purpose. A plan carries a snapshot of the issue, and the older that
 * snapshot is the more likely apply is about to reject it anyway - so the
 * window is measured in the time an agent needs to decide, not in how long a
 * person might leave a terminal open.
 */
export const PLAN_TTL_MS = 10 * 60 * 1000;

const KEY_PATTERN = /^([A-Z][A-Z0-9_]*)-(\d+)$/;

/**
 * Which project an issue key belongs to.
 *
 * Parsed rather than looked up: a malformed key should be refused before it is
 * spent on a Jira round trip.
 */
export function projectKeyOf(issueKey: string): string | undefined {
  return KEY_PATTERN.exec(issueKey.trim().toUpperCase())?.[1];
}

/**
 * Writes stay inside the project this workspace is bound to.
 *
 * The binding is what the user consented to when they set JAM up. An agent
 * holding a key from somewhere else - copied from a link, inferred from a
 * comment - must not be able to reach into another team's project through it.
 */
export function assertWriteScope(issueKey: string, configuredProject: string): string {
  const project = projectKeyOf(issueKey);
  if (!project) {
    throw new JamError(
      "JAM_WRITE_SCOPE_VIOLATION",
      `"${issueKey}" is not a Jira issue key.`,
      { issueKey },
    );
  }
  const configured = configuredProject.trim().toUpperCase();
  if (!configured) {
    throw new JamError(
      "JAM_SETUP_REQUIRED",
      "No Jira project is configured for this workspace, so JAM cannot tell whether this write is in scope.",
      { issueKey },
    );
  }
  if (project !== configured) {
    throw new JamError(
      "JAM_WRITE_SCOPE_VIOLATION",
      `${issueKey} belongs to project ${project}, but this workspace is bound to ${configured}. JAM writes only within the configured project.`,
      { issueKey, project, configuredProject: configured },
    );
  }
  return project;
}

export function assertOperationAllowed(operation: string): WriteOperation {
  if (!isWriteOperation(operation)) {
    throw new JamError(
      "JAM_WRITE_OPERATION_NOT_ALLOWED",
      `"${operation}" is not a JAM write operation. Supported: ${WRITE_OPERATIONS.join(", ")}.`,
      { operation, supported: [...WRITE_OPERATIONS] },
    );
  }
  return operation;
}

/**
 * Reject anything outside the field whitelist before planning goes further.
 *
 * Returns the requested fields in whitelist order so a plan's `before` and
 * `intendedAfter` are comparable regardless of how the caller ordered them.
 */
export function assertFieldsAllowed(input: FieldUpdateInput): FieldUpdateInput {
  const requested = Object.keys(input).filter((key) => input[key as keyof FieldUpdateInput] !== undefined);

  if (requested.length === 0) {
    throw new JamError(
      "JAM_WRITE_FIELD_NOT_ALLOWED",
      `field.update needs at least one field. Supported: ${WRITABLE_FIELDS.join(", ")}.`,
      { supported: [...WRITABLE_FIELDS] },
    );
  }

  const rejected = requested.filter((key) => !isWritableField(key));
  if (rejected.length > 0) {
    throw new JamError(
      "JAM_WRITE_FIELD_NOT_ALLOWED",
      `JAM cannot write ${rejected.join(", ")}. Supported: ${WRITABLE_FIELDS.join(", ")}.`,
      { rejected, supported: [...WRITABLE_FIELDS] },
    );
  }

  const ordered: FieldUpdateInput = {};
  for (const field of WRITABLE_FIELDS) {
    const value = input[field];
    if (value !== undefined) Object.assign(ordered, { [field]: value });
  }
  return ordered;
}

/**
 * Match a requested status against what Jira currently offers.
 *
 * Jira's transition ids are per-workflow and not derivable from a status name,
 * so this only ever selects from transitions Jira just reported. When nothing
 * matches, the available names go back with the error - the agent's next move
 * is to pick one of them, not to try harder at the same one.
 */
export function resolveTransition(
  target: string,
  available: JiraTransition[],
): JiraTransition {
  const wanted = target.trim().toLowerCase();
  const match =
    available.find((t) => t.to.toLowerCase() === wanted) ??
    available.find((t) => t.name.toLowerCase() === wanted);

  if (!match) {
    throw new JamError(
      "JAM_WRITE_TRANSITION_NOT_AVAILABLE",
      available.length === 0
        ? `Jira offers no transitions from this issue's current status for this account, so it cannot be moved to "${target}".`
        : `"${target}" is not reachable from this issue's current status. Available: ${available.map((t) => t.to).join(", ")}.`,
      { target, available: available.map((t) => ({ id: t.id, name: t.name, to: t.to })) },
    );
  }
  return match;
}

export function planExpired(expiresAt: string, now: Date): boolean {
  return now.getTime() >= Date.parse(expiresAt);
}

/**
 * Has the issue moved since the plan was made?
 *
 * Jira's `updated` timestamp is the revision marker: it changes on any edit,
 * including ones JAM did not make and cannot see the shape of. Comparing it is
 * what stops an agent applying a decision it made against an issue that no
 * longer exists in that form.
 */
export function assertUnchanged(issueKey: string, baseUpdated: string, currentUpdated: string): void {
  if (baseUpdated === currentUpdated) return;
  throw new JamError(
    "JAM_WRITE_CONFLICT",
    `${issueKey} changed after this plan was made, so the plan no longer describes the issue. Re-plan against the current state.`,
    { issueKey, planUpdated: baseUpdated, currentUpdated },
  );
}
