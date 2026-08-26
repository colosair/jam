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
