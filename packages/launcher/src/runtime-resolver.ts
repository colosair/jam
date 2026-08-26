import { LauncherError } from "./errors.js";
import { resolveDevelopmentRuntime } from "./development-runtime.js";
import { resolvePackageRuntime } from "./package-runtime.js";
import { readRuntimeConfig, type RuntimeConfig, type RuntimeMode } from "./runtime-config.js";
import { portableBootstrapCommand } from "./release.js";

export type ResolvedRuntime = {
  mode: RuntimeMode;
  version: string;
  executable: {
    command: string;
    args: string[];
  };
};

export const BOOTSTRAP_INIT_COMMAND = portableBootstrapCommand("init");

/**
 * Turn the user's runtime choice into an actual command to run.
 *
 * This is the whole of the launcher's decision-making: which JAM build, and
 * where. Everything past this point - credentials, project config, Jira
 * itself - belongs to the server, and deliberately has no representation here.
 */
export function resolveRuntime(config: RuntimeConfig): ResolvedRuntime {
  return config.runtime.mode === "package"
    ? resolvePackageRuntime()
    : resolveDevelopmentRuntime(config.runtime.source);
}

/** Resolve from the user's on-disk config, or explain that there isn't one yet. */
export function resolveConfiguredRuntime(home?: string): ResolvedRuntime {
  const config = readRuntimeConfig(home);
  if (!config) {
    throw new LauncherError(
      "JAM_RUNTIME_CONFIG_MISSING",
      "JAM runtime is not configured for this user.",
      BOOTSTRAP_INIT_COMMAND,
    );
  }
  return resolveRuntime(config);
}
