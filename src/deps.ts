import { NoopCache } from "./adapters/cache/noop-cache.js";
import { CompositeCredentialProvider } from "./adapters/credentials/composite.js";
import { ConsoleTelemetry } from "./adapters/telemetry/console-telemetry.js";
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
   * Attempt safe project.yaml bootstrap when none exists. `jam serve` and
   * `jam setup` pass true; `jam doctor` leaves this false, since doctor only
   * reports on what already exists and never writes.
   */
  bootstrap?: boolean;
  /** `--project` override, passed through from `jam setup`. */
  explicitKey?: string;
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
    bootstrap: options.bootstrap ?? false,
    explicitKey: options.explicitKey,
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
    jira,
    cache: new NoopCache(),
    telemetry,
    credentials,
  };
}
