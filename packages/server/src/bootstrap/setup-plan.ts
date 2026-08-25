import { join } from "node:path";
import { CONFIG_RELATIVE_PATH } from "../config/load-config.js";
import { decideProjectKey, type BootstrapSource } from "./project-config-bootstrapper.js";
import type { SetupState } from "./setup-state.js";

export type SetupStatus = "already_configured" | "ready_to_apply" | "user_action_required";

export type SetupCode =
  | "JAM_PROJECT_SELECTION_REQUIRED"
  | "JAM_AUTH_REQUIRED"
  | "JAM_RUNTIME_CONFIG_MISSING"
  | "JAM_PROJECT_CONFIG_INVALID"
  | "JAM_MCP_CONFIG_UNREADABLE";

export type SetupChange =
  | {
      type: "create";
      target: "project-config";
      path: string;
      key: string;
      keySource: BootstrapSource;
    }
  | { type: "create"; target: "mcp-config"; path: string }
  | { type: "merge"; target: "mcp-config"; path: string; preserveExisting: string[] }
  | { type: "replace"; target: "mcp-config"; path: string; reason: "migrate" };

export type SetupPlan = {
  status: SetupStatus;
  code?: SetupCode;
  changes: SetupChange[];
  requiresUserAction: boolean;
  /** Populated by the caller when status is JAM_PROJECT_SELECTION_REQUIRED. */
  projects?: { key: string; name: string }[];
  nextAction?: { type: "authenticate" | "select_project" | "configure_runtime"; command?: string };
  project?: { root: string; key?: string };
};

export type PlanOptions = {
  /** `--project KEY`. */
  explicitKey?: string;
  /** `--migrate`: rewrite a legacy jam entry instead of leaving it alone. */
  migrate?: boolean;
  env?: NodeJS.ProcessEnv;
  presetsPath?: string;
  /** True when the existing jam entry does not match the current canonical form. */
  jamEntryIsLegacy?: boolean;
};

/**
 * Decide what setup would do, changing nothing.
 *
 * Pure by construction: every input arrives through `state` and `options`, and
 * the result is a list of changes for apply to execute verbatim. Keeping the
 * decision separate from the mutation is what lets a human preview it, an
 * agent reason about it, and both go through identical logic.
 *
 * Safe Bootstrap is preserved here: a project key comes from an explicit
 * source or not at all. JAM never infers one from a repo or directory name.
 */
export function computeSetupPlan(state: SetupState, options: PlanOptions = {}): SetupPlan {
  const changes: SetupChange[] = [];

  // A config file that exists but cannot be parsed is a stop, not something to
  // overwrite - the user's settings are in there.
  if (state.project.error) {
    return {
      status: "user_action_required",
      code: "JAM_PROJECT_CONFIG_INVALID",
      changes: [],
      requiresUserAction: true,
      project: { root: state.project.root },
    };
  }
  if (state.mcp.unreadable) {
    return {
      status: "user_action_required",
      code: "JAM_MCP_CONFIG_UNREADABLE",
      changes: [],
      requiresUserAction: true,
      project: { root: state.project.root },
    };
  }

  const key = resolveKey(state, options);
  if (!key) {
    return {
      status: "user_action_required",
      code: "JAM_PROJECT_SELECTION_REQUIRED",
      changes: [],
      requiresUserAction: true,
      nextAction: { type: "select_project", command: "jam setup --project <KEY>" },
      project: { root: state.project.root },
    };
  }

  if (!state.project.hasConfig) {
    changes.push({
      type: "create",
      target: "project-config",
      path: joinConfigPath(state.project.root),
      key: key.key,
      keySource: key.source,
    });
  }

  const mcpChange = planMcpChange(state, options);
  if (mcpChange) changes.push(mcpChange);

  const project = { root: state.project.root, key: key.key };

  // Credentials are a human boundary: JAM can wire the project up regardless,
  // but it cannot authenticate on the user's behalf. The plan therefore still
  // carries its changes - apply them, then stop for the person.
  if (!state.credentials.present) {
    return {
      status: "user_action_required",
      code: "JAM_AUTH_REQUIRED",
      changes,
      requiresUserAction: true,
      nextAction: { type: "authenticate" },
      project,
    };
  }

  if (!state.runtime.configured) {
    return {
      status: "user_action_required",
      code: "JAM_RUNTIME_CONFIG_MISSING",
      changes,
      requiresUserAction: true,
      nextAction: { type: "configure_runtime", command: "jam runtime use package" },
      project,
    };
  }

  return {
    status: changes.length === 0 ? "already_configured" : "ready_to_apply",
    changes,
    requiresUserAction: false,
    project,
  };
}

function resolveKey(
  state: SetupState,
  options: PlanOptions,
): { key: string; source: BootstrapSource } | undefined {
  // An existing project.yaml wins: setup must never silently repoint a project.
  if (state.project.key) return { key: state.project.key, source: "explicit" };

  const decideOptions: Parameters<typeof decideProjectKey>[1] = {};
  if (options.explicitKey) decideOptions.explicitKey = options.explicitKey;
  if (options.env) decideOptions.env = options.env;
  if (options.presetsPath) decideOptions.presetsPath = options.presetsPath;

  return decideProjectKey(state.project.root, decideOptions);
}

function planMcpChange(state: SetupState, options: PlanOptions): SetupChange | undefined {
  if (!state.mcp.exists) {
    return { type: "create", target: "mcp-config", path: state.mcp.path };
  }
  if (!state.mcp.hasJamEntry) {
    return {
      type: "merge",
      target: "mcp-config",
      path: state.mcp.path,
      preserveExisting: state.mcp.otherServers,
    };
  }
  // An existing jam entry is left alone unless migration was asked for
  // explicitly - overwriting someone's customised wiring is not setup's call.
  const legacy = options.jamEntryIsLegacy ?? state.mcp.jamEntryIsLegacy;
  if (options.migrate && legacy) {
    return { type: "replace", target: "mcp-config", path: state.mcp.path, reason: "migrate" };
  }
  return undefined;
}

function joinConfigPath(root: string): string {
  return join(root, CONFIG_RELATIVE_PATH);
}
