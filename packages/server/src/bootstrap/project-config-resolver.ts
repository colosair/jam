import { resolve } from "node:path";
import { loadConfig } from "../config/load-config.js";
import type { ProjectConfig } from "../config/schema.js";
import { JamError } from "../domain/errors.js";
import { decideProjectKey, writeBootstrapConfig } from "./project-config-bootstrapper.js";
import { resolveProjectRoot } from "./project-root-resolver.js";

export type ResolvedProjectConfig = {
  config: ProjectConfig;
  configPath?: string;
  root: string;
  /** True when this call just created `.jira-agent/project.yaml`. */
  bootstrapped: boolean;
};

export type ResolveConfigOptions = {
  cwd?: string;
  /**
   * Attempt safe bootstrap when no config exists. `jam serve` and `jam setup`
   * pass true; `jam doctor` passes false/omits it, since doctor only reports
   * on what already exists.
   */
  bootstrap?: boolean;
  /** `--project` override, only consulted when `bootstrap` is true. */
  explicitKey?: string;
  /** Injected by tests so a decision never depends on the machine's JAM_PROJECT_KEY. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Find (or, when asked, safely create) this project's JAM config.
 *
 * Throws JAM_SETUP_REQUIRED when bootstrap is requested but no config exists
 * and no explicit key source (flag, env, preset) can supply one - JAM never
 * guesses a Jira project from a repo or folder name.
 */
export function resolveProjectConfig(options: ResolveConfigOptions = {}): ResolvedProjectConfig {
  const cwd = resolve(options.cwd ?? process.cwd());
  const { root, hasConfig } = resolveProjectRoot(cwd);

  if (hasConfig) {
    const loaded = loadConfig(root);
    return { config: loaded.config, configPath: loaded.path, root, bootstrapped: false };
  }

  if (!options.bootstrap) {
    const loaded = loadConfig(cwd);
    return { config: loaded.config, configPath: loaded.path, root, bootstrapped: false };
  }

  const decision = decideProjectKey(root, {
    ...(options.explicitKey ? { explicitKey: options.explicitKey } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  if (!decision) {
    throw new JamError(
      "JAM_SETUP_REQUIRED",
      `No .jira-agent/project.yaml found under ${root}, and no project key could be determined safely (no --project, no JAM_PROJECT_KEY, no matching preset). Run \`jam setup --project <KEY>\`.`,
      { root },
    );
  }

  writeBootstrapConfig(root, decision.key);
  const loaded = loadConfig(root);
  return { config: loaded.config, configPath: loaded.path, root, bootstrapped: true };
}
