import { NoopCache } from "./adapters/cache/noop-cache.js";
import { CompositeCredentialProvider } from "./adapters/credentials/composite.js";
import { ConsoleTelemetry } from "./adapters/telemetry/console-telemetry.js";
import type { BootstrapSource } from "./bootstrap/project-config-bootstrapper.js";
import type { GitRemoteFn } from "./bootstrap/workspace-identity.js";
import { resolveProjectConfig } from "./bootstrap/project-config-resolver.js";
import type { ProjectConfig } from "./config/schema.js";
import type { CachePort } from "./ports/cache.port.js";
import type { CredentialPort } from "./ports/credentials.port.js";
import type { JiraReadPort } from "./ports/jira-read.port.js";
import type { TelemetryPort } from "./ports/telemetry.port.js";

/** Everything the application layer is allowed to reach for. */
export type JamDeps = {
  config: ProjectConfig;
  configPath?: string;
  /** Where the project key came from when no config file supplied one. */
  keySource?: BootstrapSource;
  jira: JiraReadPort;
  cache: CachePort;
  telemetry: TelemetryPort;
  credentials: CredentialPort;
};

export type BuildDepsOptions = {
  cwd?: string;
  /** Injected by tests to bypass the real REST adapter. */
  jira?: JiraReadPort;
  /** Injected by tests to bypass the real process/registry credential lookup. */
  credentials?: CredentialPort;
  /**
   * Whether an explicit key (flag, env, personal binding, preset) may stand in
   * when the project has no config file, and whether its absence is fatal.
   * Nothing is written either way - see resolveProjectConfig.
   */
  keyFallback?: "required" | "optional";
  /** `--project` override, passed through from `jam setup`. */
  explicitKey?: string;
  /** Injected by tests so a decision never depends on the machine's environment. */
  env?: NodeJS.ProcessEnv;
  /** Injected by tests so a decision never reads the developer's own presets. */
  presetsPath?: string;
  /** Injected by tests to isolate `~/.jam`. */
  home?: string;
  /** Injected by tests so identity never depends on the checkout under test. */
  git?: GitRemoteFn;
};

/**
 * Single composition root. `jam serve`, `jam doctor` and `jam setup` all wire
 * through here, so a doctor pass actually proves the server's configuration.
 *
 * Credentials come from `CompositeCredentialProvider`: the current process's
 * own environment first, then the Windows User environment as a fallback for
 * shells that predate a `setx`.
 */
export async function buildDeps(options: BuildDepsOptions = {}): Promise<JamDeps> {
  const resolved = resolveProjectConfig({
    cwd: options.cwd,
    ...(options.keyFallback ? { keyFallback: options.keyFallback } : {}),
    explicitKey: options.explicitKey,
    ...(options.env ? { env: options.env } : {}),
    ...(options.presetsPath ? { presetsPath: options.presetsPath } : {}),
    ...(options.home ? { home: options.home } : {}),
    ...(options.git ? { git: options.git } : {}),
  });
  const credentials = options.credentials ?? new CompositeCredentialProvider();
  const telemetry = new ConsoleTelemetry(resolved.config.telemetry.enabled);

  let jira = options.jira;
  if (!jira) {
    const { JiraCloudReadAdapter } = await import(
      "./adapters/jira-cloud/jira-read.adapter.js"
    );
    jira = new JiraCloudReadAdapter(credentials, resolved.config);
  }

  return {
    config: resolved.config,
    configPath: resolved.configPath,
    keySource: resolved.keySource,
    jira,
    cache: new NoopCache(),
    telemetry,
    credentials,
  };
}
