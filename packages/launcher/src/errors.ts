/**
 * Launcher-level failures. These are deliberately distinct from JAM's own
 * error codes: they describe problems reaching a JAM runtime at all, before
 * any Jira concern exists.
 */
export const LAUNCHER_ERROR_CODES = [
  "JAM_RUNTIME_CONFIG_MISSING",
  "JAM_DEVELOPMENT_SOURCE_INVALID",
  "JAM_PACKAGE_RUNTIME_FAILED",
] as const;

export type LauncherErrorCode = (typeof LAUNCHER_ERROR_CODES)[number];

export class LauncherError extends Error {
  readonly code: LauncherErrorCode;
  /** Command the user should run to fix this, when there is a single obvious one. */
  readonly nextCommand?: string;

  constructor(code: LauncherErrorCode, message: string, nextCommand?: string) {
    super(message);
    this.name = "LauncherError";
    this.code = code;
    if (nextCommand) this.nextCommand = nextCommand;
  }
}
