import {
  readRuntimeConfig,
  resolveRuntime,
  type RuntimeMode,
} from "@jam-mcp/launcher";
import { CompositeCredentialProvider } from "../adapters/credentials/composite.js";
import { loadConfig } from "../config/load-config.js";
import type { CredentialPort, CredentialSource } from "../ports/credentials.port.js";
import { inspectMcpConfig, type McpInspection } from "./mcp-config-merger.js";
import { resolveProjectRoot } from "./project-root-resolver.js";

export type RuntimeState = {
  configured: boolean;
  mode?: RuntimeMode;
  source?: string;
  version?: string;
  /** Set when a runtime is configured but cannot currently be resolved. */
  error?: string;
};

export type CredentialState = {
  present: boolean;
  source: CredentialSource;
  baseUrl?: string;
  email?: string;
};

export type ProjectState = {
  root: string;
  hasConfig: boolean;
  configPath?: string;
  key?: string;
  /** Set when a config file exists but could not be parsed. */
  error?: string;
};

export type SetupState = {
  cwd: string;
  runtime: RuntimeState;
  credentials: CredentialState;
  project: ProjectState;
  mcp: McpInspection;
};

export type DetectOptions = {
  cwd?: string;
  /** Injected by tests to isolate ~/.jam. */
  home?: string;
  credentials?: CredentialPort;
};

/**
 * Snapshot everything setup needs to decide, without changing any of it.
 *
 * Strictly read-only: no file is created, and no config is bootstrapped. That
 * separation is what makes `setup plan` safe to run speculatively, and what
 * lets an agent inspect a machine before proposing anything.
 */
export function detectSetupState(options: DetectOptions = {}): SetupState {
  const cwd = options.cwd ?? process.cwd();

  return {
    cwd,
    runtime: detectRuntime(options.home),
    credentials: detectCredentials(options.credentials ?? new CompositeCredentialProvider()),
    project: detectProject(cwd),
    mcp: inspectMcpConfig(resolveProjectRoot(cwd).root),
  };
}

function detectRuntime(home?: string): RuntimeState {
  const config = readRuntimeConfig(home);
  if (!config) return { configured: false };

  const state: RuntimeState = { configured: true, mode: config.runtime.mode };
  if (config.runtime.mode === "development") state.source = config.runtime.source;

  try {
    state.version = resolveRuntime(config).version;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }
  return state;
}

function detectCredentials(credentials: CredentialPort): CredentialState {
  const described = credentials.describe();
  const state: CredentialState = {
    present: Boolean(described.baseUrl && described.email && described.hasToken),
    source: described.source,
  };
  // Presence and origin only - the token value never enters this snapshot.
  if (described.baseUrl) state.baseUrl = described.baseUrl;
  if (described.email) state.email = described.email;
  return state;
}

function detectProject(cwd: string): ProjectState {
  const { root, hasConfig } = resolveProjectRoot(cwd);
  if (!hasConfig) return { root, hasConfig: false };

  try {
    const loaded = loadConfig(root);
    const state: ProjectState = { root, hasConfig: true };
    if (loaded.path) state.configPath = loaded.path;
    if (loaded.config.project.key) state.key = loaded.config.project.key;
    return state;
  } catch (err) {
    return {
      root,
      hasConfig: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
