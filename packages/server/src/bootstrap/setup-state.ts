import {
  readRuntimeConfig,
  resolveRuntime,
  type RuntimeMode,
} from "@jam-mcp/launcher";
import { CompositeCredentialProvider } from "../adapters/credentials/composite.js";
import { loadConfig } from "../config/load-config.js";
import type { CredentialPort, CredentialSource } from "../ports/credentials.port.js";
import { detectHosts, type HostRunner, type HostState } from "./host-mcp.js";
import { inspectMcpConfig, isLegacyJamEntry, type McpInspection } from "./mcp-config-merger.js";
import { inspectProjectBindings, type ProjectBinding } from "./project-bindings.js";
import { resolveProjectRoot } from "./project-root-resolver.js";
import { workspaceIdentity, type GitRemoteFn } from "./workspace-identity.js";

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
  /** What this user has bound this workspace to, if anything. */
  binding?: ProjectBinding;
};

export type SetupState = {
  cwd: string;
  /** Stable id for this workspace - what a personal binding is recorded against. */
  workspaceId: string;
  /**
   * True when `~/.jam/projects.yaml` exists but could not be read. Recorded
   * rather than thrown so planning can refuse to rewrite it, instead of
   * discovering the problem halfway through applying.
   */
  bindingsUnreadable: boolean;
  runtime: RuntimeState;
  credentials: CredentialState;
  project: ProjectState;
  mcp: McpInspection & { jamEntryIsLegacy: boolean };
  /**
   * The coding agents on this machine and whether each already knows about
   * jam. Empty unless probing was asked for: it costs a process launch per
   * host, which `jam doctor` has no reason to pay.
   */
  hosts: HostState[];
};

export type DetectOptions = {
  cwd?: string;
  /** Injected by tests to isolate ~/.jam. */
  home?: string;
  credentials?: CredentialPort;
  /** Injected by tests so identity never depends on the checkout under test. */
  git?: GitRemoteFn;
  /** Probe the host CLIs. Only the setup paths need this. */
  probeHosts?: boolean;
  /** Injected by tests so no test ever reaches a real host CLI. */
  runHost?: HostRunner;
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
  const located = resolveProjectRoot(cwd);
  const workspaceId = workspaceIdentity(located.root, {
    ...(located.gitRoot ? { gitRoot: located.gitRoot } : {}),
    ...(options.git ? { git: options.git } : {}),
  });
  const bindings = inspectProjectBindings(options.home);
  const binding = bindings.bindings.find((b) => b.workspace === workspaceId);

  return {
    cwd,
    workspaceId,
    bindingsUnreadable: bindings.status === "unreadable",
    runtime: detectRuntime(options.home),
    credentials: detectCredentials(options.credentials ?? new CompositeCredentialProvider()),
    project: { ...detectProject(located), ...(binding ? { binding } : {}) },
    mcp: detectMcp(located.root),
    hosts: options.probeHosts ? detectHosts(options.runHost) : [],
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

function detectProject(located: { root: string; hasConfig: boolean }): ProjectState {
  const { root, hasConfig } = located;
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

/** Inspection plus whether the existing jam entry predates launcher-based wiring. */
function detectMcp(root: string): McpInspection & { jamEntryIsLegacy: boolean } {
  const inspection = inspectMcpConfig(root);
  return { ...inspection, jamEntryIsLegacy: isLegacyJamEntry(inspection.jamEntry) };
}
