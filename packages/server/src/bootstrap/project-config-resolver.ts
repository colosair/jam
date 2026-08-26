import { resolve } from "node:path";
import { loadConfig } from "../config/load-config.js";
import { ProjectConfigSchema, type ProjectConfig } from "../config/schema.js";
import { JamError } from "../domain/errors.js";
import { decideProjectKey, type BootstrapSource } from "./project-config-bootstrapper.js";
import { resolveProjectRoot } from "./project-root-resolver.js";

export type ResolvedProjectConfig = {
  config: ProjectConfig;
  configPath?: string;
  root: string;
  /**
   * Where the key came from when no config file supplied it. Undefined when
   * `configPath` is set - "from the file" is what `configPath` already says.
   */
  keySource?: BootstrapSource;
};

export type ResolveConfigOptions = {
  cwd?: string;
  /**
   * When no config file exists, allow an explicitly supplied key (flag, env,
   * preset) to stand in. Resolution only - nothing is written either way.
   * `jam serve` passes true; the read-only commands leave it off.
   */
  allowKeyFallback?: boolean;
  /** `--project` override, only consulted when `allowKeyFallback` is true. */
  explicitKey?: string;
  /** Injected by tests so a decision never depends on the machine's JAM_PROJECT_KEY. */
  env?: NodeJS.ProcessEnv;
  /** Injected by tests so a decision never reads the developer's own presets. */
  presetsPath?: string;
};

/**
 * Find this project's JAM config, or decide its key in memory.
 *
 * Reads and decides; it never writes. Persisting a decision is `jam setup`'s
 * job alone (`setup-apply.ts`), because creating a file in someone's
 * repository is a change they asked for, not a side effect of starting a
 * server.
 *
 * Throws JAM_SETUP_REQUIRED when a key is allowed to come from a fallback but
 * no explicit source can supply one - JAM never guesses a Jira project from a
 * repo or folder name.
 */
export function resolveProjectConfig(options: ResolveConfigOptions = {}): ResolvedProjectConfig {
  const cwd = resolve(options.cwd ?? process.cwd());
  const { root, hasConfig } = resolveProjectRoot(cwd);

  if (hasConfig) {
    const loaded = loadConfig(root);
    return { config: loaded.config, configPath: loaded.path, root };
  }

  if (!options.allowKeyFallback) {
    const loaded = loadConfig(cwd);
    return { config: loaded.config, configPath: loaded.path, root };
  }

  const decision = decideProjectKey(root, {
    ...(options.explicitKey ? { explicitKey: options.explicitKey } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.presetsPath ? { presetsPath: options.presetsPath } : {}),
  });
  if (!decision) {
    throw new JamError(
      "JAM_SETUP_REQUIRED",
      `No .jira-agent/project.yaml found under ${root}, and no project key could be determined safely (no --project, no JAM_PROJECT_KEY, no matching preset). Run \`jam setup --project <KEY>\`.`,
      { root },
    );
  }

  // The file this used to write held nothing but the key: every other field
  // came back from schema defaults on the next read. Parsing the key directly
  // produces the same config without touching the repository.
  return {
    config: ProjectConfigSchema.parse({ project: { key: decision.key } }),
    root,
    keySource: decision.source,
  };
}
