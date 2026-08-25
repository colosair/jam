import { SERVER_PACKAGE_SPEC, SERVER_VERSION } from "./release.js";
import type { ResolvedRuntime } from "./runtime-resolver.js";

/**
 * Package mode: run the published server through npx at an exact version.
 *
 * `--yes` keeps npx from prompting, which matters because this runs as an MCP
 * child process with no usable terminal.
 */
export function resolvePackageRuntime(): ResolvedRuntime {
  return {
    mode: "package",
    version: SERVER_VERSION,
    executable: {
      command: "npx",
      args: ["--yes", SERVER_PACKAGE_SPEC],
    },
  };
}
