import { NoopCache } from "./adapters/cache/noop-cache.js";
import { EnvCredentials } from "./adapters/credentials/env-credentials.js";
import { ConsoleTelemetry } from "./adapters/telemetry/console-telemetry.js";
import { loadConfig } from "./config/load-config.js";
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
};

/**
 * Single composition root. `jam serve` and `jam doctor` wire the same way so a
 * doctor pass actually proves the server's configuration.
 */
export async function buildDeps(options: BuildDepsOptions = {}): Promise<JamDeps> {
  const { config, path } = loadConfig(options.cwd);
  const credentials = new EnvCredentials();
  const telemetry = new ConsoleTelemetry(config.telemetry.enabled);

  let jira = options.jira;
  if (!jira) {
    const { JiraCloudReadAdapter } = await import(
      "./adapters/jira-cloud/jira-read.adapter.js"
    );
    jira = new JiraCloudReadAdapter(credentials, config);
  }

  return {
    config,
    configPath: path,
    jira,
    cache: new NoopCache(),
    telemetry,
    credentials,
  };
}
