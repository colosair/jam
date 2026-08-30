/**
 * The JAM release this launcher belongs to.
 *
 * server, launcher and bootstrap ship as one lockstep 1.x release, so this
 * file is the single source of that pairing. Exact pins on purpose - no
 * `@latest`, no major alias - so a given launcher build always runs the
 * server build it was tested against.
 *
 * When projects gain a required-version field, SERVER_VERSION becomes the
 * default that the project's own pin overrides, not a value that disappears.
 */
export const SERVER_PACKAGE = "@jam-mcp/server";
export const SERVER_VERSION = "1.4.0";
export const SERVER_PACKAGE_SPEC = `${SERVER_PACKAGE}@${SERVER_VERSION}`;

export const LAUNCHER_PACKAGE = "@jam-mcp/launcher";
export const LAUNCHER_PACKAGE_SPEC = `${LAUNCHER_PACKAGE}@${SERVER_VERSION}`;

/**
 * The zero-state entry point.
 *
 * Anything JAM tells a machine to run has to work on a machine where JAM is
 * not installed and no runtime is configured yet - which rules out both a
 * global `jam` and the launcher itself, since the launcher can only dispatch
 * once `~/.jam/config.yaml` exists. Bootstrap has neither precondition.
 */
export const BOOTSTRAP_PACKAGE = "@jam-mcp/bootstrap";
export const BOOTSTRAP_PACKAGE_SPEC = `${BOOTSTRAP_PACKAGE}@${SERVER_VERSION}`;

/** A command any machine can run, whatever is or is not installed on it. */
export function portableBootstrapCommand(args: string): string {
  return `npx --yes ${BOOTSTRAP_PACKAGE_SPEC} ${args}`;
}
