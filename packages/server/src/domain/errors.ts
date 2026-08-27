/**
 * Normalized error model.
 *
 * Jira raw errors never reach the agent. Everything crossing the tool boundary
 * is mapped onto one of these codes so the agent (and `jam doctor`) can reason
 * about failures without parsing vendor-specific payloads.
 */
export const JAM_ERROR_CODES = [
  "JIRA_AUTH_FAILED",
  "JIRA_PERMISSION_DENIED",
  "JQL_INVALID",
  "ISSUE_NOT_FOUND",
  "RATE_LIMITED",
  "CONTEXT_TOO_LARGE",
  "PARTIAL_RESULT",
  "CONFIG_INVALID",
  "JIRA_UNAVAILABLE",
  "JAM_SETUP_REQUIRED",
  "JAM_BINDINGS_UNREADABLE",

  // Write plane. Each names a distinct decision an agent has to make, which is
  // why none of them collapse into CONFIG_INVALID: "you may not write there",
  // "someone else moved it", and "we could not confirm it happened" call for
  // three different next steps.
  "JAM_WRITE_SCOPE_VIOLATION",
  "JAM_WRITE_OPERATION_NOT_ALLOWED",
  "JAM_WRITE_FIELD_NOT_ALLOWED",
  "JAM_WRITE_TRANSITION_NOT_AVAILABLE",
  // Creation. Each is a refusal JAM makes before Jira is asked to act, or a
  // premise that stopped holding between planning and applying - never a raw
  // Jira 400 passed along. "That type is not on offer", "this project needs a
  // field JAM cannot fill" and "the schema moved under the plan" are three
  // different next steps for whoever is holding the agent.
  "JAM_WRITE_ISSUE_TYPE_NOT_AVAILABLE",
  "JAM_WRITE_REQUIRED_FIELD_UNSUPPORTED",
  "JAM_WRITE_VALUE_NOT_ALLOWED",
  "JAM_WRITE_SCHEMA_CHANGED",
  "JAM_WRITE_PLAN_NOT_FOUND",
  "JAM_WRITE_PLAN_EXPIRED",
  "JAM_WRITE_CONFLICT",
  "JAM_WRITE_VERIFICATION_FAILED",
  "JAM_WRITE_UNCERTAIN",
] as const;

export type JamErrorCode = (typeof JAM_ERROR_CODES)[number];

export type JamErrorPayload = {
  error: {
    code: JamErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
};

export class JamError extends Error {
  readonly code: JamErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: JamErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "JamError";
    this.code = code;
    this.details = details;
  }

  toPayload(): JamErrorPayload {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/**
 * Coerce anything thrown into a JamError. Unknown failures become
 * JIRA_UNAVAILABLE rather than leaking a raw stack trace to the agent.
 */
export function toJamError(err: unknown): JamError {
  if (err instanceof JamError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new JamError("JIRA_UNAVAILABLE", message);
}
