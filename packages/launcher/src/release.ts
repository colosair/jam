/**
 * The JAM server version this launcher dispatches to in package mode.
 *
 * server, launcher and bootstrap ship as a lockstep 1.x release, so this
 * constant is the single source of that pairing. Exact pin on purpose - no
 * `@latest`, no major alias - so a given launcher build always runs the
 * server build it was tested against.
 *
 * When projects gain a required-version field, this becomes the default that
 * the project's own pin overrides, not a value that disappears.
 */
export const SERVER_PACKAGE = "@jam-mcp/server";
export const SERVER_VERSION = "1.0.0";
export const SERVER_PACKAGE_SPEC = `${SERVER_PACKAGE}@${SERVER_VERSION}`;
