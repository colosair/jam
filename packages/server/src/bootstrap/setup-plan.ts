import { join } from "node:path";
import { CONFIG_RELATIVE_PATH } from "../config/load-config.js";
import { hostRegistration, preferBareRegistration, hostUnregistration, type HostId } from "./host-mcp.js";
import type { MigrationTarget } from "./migration-target.js";
import { projectBindingsPath } from "./project-bindings.js";
import { decideProjectKey, type BootstrapSource } from "./project-config-bootstrapper.js";
import type { SetupState } from "./setup-state.js";
import { portableBootstrapCommand } from "@jam-mcp/launcher";

export type SetupStatus = "already_configured" | "ready_to_apply" | "user_action_required";

export type SetupCode =
  | "JAM_PROJECT_SELECTION_REQUIRED"
  | "JAM_BINDINGS_UNREADABLE"
  | "JAM_AUTH_REQUIRED"
  | "JAM_RUNTIME_CONFIG_MISSING"
  | "JAM_PROJECT_CONFIG_INVALID"
  | "JAM_MCP_CONFIG_UNREADABLE"
  | "JAM_MIGRATION_TARGET_UNAVAILABLE"
  | "JAM_PROJECT_KEY_CONFLICT";

/**
 * Where a project key came from. `repository` is the team's committed
 * `.jira-agent/project.yaml`; the rest are this user's own settings, in the
 * precedence order `decideProjectKey` applies.
 */
export type KeySource = BootstrapSource | "repository";

export type KeyOrigin = { key: string; source: KeySource };

export type SetupChange =
  | {
      type: "create";
      target: "project-config";
      path: string;
      key: string;
      keySource: KeySource;
    }
  | { type: "create"; target: "mcp-config"; path: string }
  | { type: "merge"; target: "mcp-config"; path: string; preserveExisting: string[] }
  | { type: "replace"; target: "mcp-config"; path: string; reason: "migrate" }
  | {
      type: "create" | "replace";
      target: "personal-binding";
      path: string;
      workspaceId: string;
      key: string;
      keySource: KeySource;
      /** Present on a rebind, so the preview shows what is being replaced. */
      previousKey?: string;
    }
  | {
      type: "create" | "replace";
      target: "host-mcp";
      host: HostId;
      /**
       * The exact argv apply will run, decided here and never recomputed -
       * so `plan --json` shows what is about to happen, and running a host's
       * CLI stays on the apply side of the line.
       */
      command: string;
      args: string[];
      /**
       * Run before the registration, on a repair. The host CLI refuses to add an
       * entry that already exists, so the stale one has to go first - and which
       * command does that is decided here, not worked out during apply.
       */
      precede?: { command: string; args: string[] };
      /** On a repair: the launcher pin the entry runs today, so the preview names it. */
      previousVersion?: string;
      reason?: "stale-registration";
    };

export type SetupPlan = {
  status: SetupStatus;
  code?: SetupCode;
  changes: SetupChange[];
  requiresUserAction: boolean;
  /** Populated by the caller when status is JAM_PROJECT_SELECTION_REQUIRED. */
  projects?: { key: string; name: string }[];
  /** Why a requested migration was refused, when status is JAM_MIGRATION_TARGET_UNAVAILABLE. */
  migrationTarget?: MigrationTarget;
  /**
   * What a person or an agent has to do next.
   *
   * `command` is executable on a machine with nothing installed and no runtime
   * configured - so it is an `npx` bootstrap invocation, never a bare `jam`.
   * A human interface is free to render the short form; this field is the one
   * a script runs, and a script has no PATH to rely on.
   *
   * `userCommand` is the opposite: a command for the person, which the agent
   * relays and never runs. Authentication is the only step of that shape, and
   * it carries no `command` precisely so that no caller can execute it. The
   * separation is the point - one field is for running, the other for showing.
   *
   * `env` names the variables that would satisfy the same requirement without
   * the interactive command, so an agent that cannot show a prompt still knows
   * what the person has to provide - never their values.
   */
  nextAction?: {
    type: "authenticate" | "select_project" | "configure_runtime";
    command?: string;
    userCommand?: string;
    env?: string[];
  };
  project?: { root: string; key?: string; keySource?: KeySource };
  /** On JAM_PROJECT_KEY_CONFLICT: what was asked for, and what already stands. */
  requested?: KeyOrigin;
  existing?: KeyOrigin;
};

export type PlanOptions = {
  /**
   * `--shared`: adopt JAM for the team, writing `.jira-agent/project.yaml` and
   * `.mcp.json` into the repository. Without it setup is personal and the
   * repository is left alone - discovery is allowed, adoption is asked for.
   */
  shared?: boolean;
  /** `--project KEY`. */
  explicitKey?: string;
  /** `--migrate`: rewrite a legacy jam entry instead of leaving it alone. */
  migrate?: boolean;
  env?: NodeJS.ProcessEnv;
  presetsPath?: string;
  /** True when the existing jam entry does not match the current canonical form. */
  jamEntryIsLegacy?: boolean;
  /**
   * Whether the package a `--migrate` rewrite would point at can be resolved.
   * Observed by the caller, like `jamEntryIsLegacy` - the planner never probes.
   * Absent means not verified, and an unverified target refuses the rewrite.
   */
  migrationTarget?: MigrationTarget;
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
  const shared = options.shared ?? false;

  // A config file that exists but cannot be parsed is a stop, not something to
  // overwrite - the user's settings are in there. It is read in both scopes,
  // so a broken one blocks either.
  if (state.project.error) {
    return {
      status: "user_action_required",
      code: "JAM_PROJECT_CONFIG_INVALID",
      changes: [],
      requiresUserAction: true,
      project: { root: state.project.root },
    };
  }
  // Personal setup never opens .mcp.json, so a broken one there is not its
  // problem to report.
  if (shared && state.mcp.unreadable) {
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
      nextAction: { type: "select_project", command: portableBootstrapCommand("setup --project <KEY>") },
      project: { root: state.project.root },
    };
  }

  // The repository's committed key is the team's answer. When a personal
  // `--project` disagrees with it, neither side may win silently: overwriting
  // the repository is not setup's call, and quietly using the repository key
  // makes the flag a lie. Stop, and name both sources.
  const conflict = keyConflict(state, options, key);
  if (conflict) {
    return {
      status: "user_action_required",
      code: "JAM_PROJECT_KEY_CONFLICT",
      changes: [],
      requiresUserAction: true,
      requested: conflict.requested,
      existing: conflict.existing,
      project: { root: state.project.root, key: conflict.existing.key, keySource: conflict.existing.source },
    };
  }

  const project = { root: state.project.root, key: key.key, keySource: key.source };

  if (!shared) {
    // Personal scope: the record of "this workspace is that Jira project"
    // lives with the user, and nothing in the repository is touched.
    const bindingChange = planBindingChange(state, key);
    if (bindingChange && state.bindingsUnreadable) {
      return {
        status: "user_action_required",
        code: "JAM_BINDINGS_UNREADABLE",
        changes: [],
        requiresUserAction: true,
        project,
      };
    }
    if (bindingChange) changes.push(bindingChange);
    changes.push(...planHostChanges(state));
    return finish(changes, state, project);
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

  // A migration replaces wiring the user already has working. Refuse to plan
  // that against a destination nobody has confirmed is reachable - and answer
  // the flag they typed before reporting anything else. The rest of the plan
  // survives: declining the rewrite is no reason to leave the project unwired.
  if (mcpChange?.type === "replace" && options.migrationTarget?.available !== true) {
    return {
      status: "user_action_required",
      code: "JAM_MIGRATION_TARGET_UNAVAILABLE",
      changes,
      requiresUserAction: true,
      ...(options.migrationTarget ? { migrationTarget: options.migrationTarget } : {}),
      project,
    };
  }

  if (mcpChange) changes.push(mcpChange);

  return finish(changes, state, project);
}

/**
 * The stops that apply to either scope, and the verdict.
 *
 * Credentials and runtime are human boundaries: JAM can wire things up
 * regardless, but it cannot authenticate on the user's behalf. Both stops
 * therefore still carry their changes - apply them, then stop for the person.
 */
function finish(
  changes: SetupChange[],
  state: SetupState,
  project: { root: string; key: string },
): SetupPlan {
  if (!state.credentials.present) {
    return {
      status: "user_action_required",
      code: "JAM_AUTH_REQUIRED",
      changes,
      requiresUserAction: true,
      nextAction: {
        type: "authenticate",
        // Deliberately no `command`: an agent must not run the login, and the
        // absence is what stops it. `userCommand` is what it hands the person
        // instead - previously that instruction existed only in CLI prose, so
        // an agent reading the JSON alone knew a human was needed but not for
        // what.
        userCommand: portableBootstrapCommand("auth login"),
        env: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
      },
      project,
    };
  }

  if (!state.runtime.configured) {
    return {
      status: "user_action_required",
      code: "JAM_RUNTIME_CONFIG_MISSING",
      changes,
      requiresUserAction: true,
      nextAction: { type: "configure_runtime", command: portableBootstrapCommand("runtime use package") },
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

/**
 * Register JAM with each coding agent that can be reached and does not have
 * it yet.
 *
 * A host whose CLI is missing gets no change at all: JAM will not guess at
 * another program's config file, and a half-wired host reported as done is
 * worse than one the user is told about. The caller prints the command for
 * those.
 */
function planHostChanges(state: SetupState): SetupChange[] {
  const changes: SetupChange[] = [];
  for (const host of state.hosts) {
    if (!host.cliAvailable) continue;
    // An entry that exists but runs an older launcher is not "already set up":
    // that pin decides which server, and so which tools, the agent actually gets.
    if (host.hasJamEntry && host.entryStale !== true) continue;
    // A machine whose global `jam` already runs this release gets the
    // persistent registration; anything else keeps the npx pin fallback.
    const registration = hostRegistration(host.id, {
      bare: preferBareRegistration(state.bareLauncher),
    });
    if (!registration) continue;
    const removal = hostUnregistration(host.id);
    changes.push({
      type: host.hasJamEntry ? "replace" : "create",
      target: "host-mcp",
      host: host.id,
      command: registration.command,
      args: registration.args,
      ...(host.hasJamEntry && removal ? { precede: { command: removal.command, args: removal.args } } : {}),
      ...(host.entryVersion ? { previousVersion: host.entryVersion } : {}),
      ...(host.hasJamEntry ? { reason: "stale-registration" as const } : {}),
    });
  }
  return changes;
}

/**
 * What the binding file should say, or nothing when it already says it.
 *
 * A repository that declares its own key needs no personal note: the team's
 * file is already the answer, and recording a second copy would only create
 * something to disagree with later.
 */
function planBindingChange(
  state: SetupState,
  key: KeyOrigin,
): SetupChange | undefined {
  if (state.project.key) return undefined;

  const existing = state.project.binding;
  if (existing?.key === key.key) return undefined;

  return {
    type: existing ? "replace" : "create",
    target: "personal-binding",
    path: projectBindingsPath(),
    workspaceId: state.workspaceId,
    key: key.key,
    keySource: key.source,
    ...(existing ? { previousKey: existing.key } : {}),
  };
}

function resolveKey(state: SetupState, options: PlanOptions): KeyOrigin | undefined {
  // An existing project.yaml wins: setup must never silently repoint a project,
  // and a personal note must never override what the team committed. It is
  // labelled `repository` rather than `explicit` - a reader has to be able to
  // tell the team's committed answer from what someone typed.
  if (state.project.key) return { key: state.project.key, source: "repository" };

  const decideOptions: Parameters<typeof decideProjectKey>[1] = {};
  if (options.explicitKey) decideOptions.explicitKey = options.explicitKey;
  if (options.env) decideOptions.env = options.env;
  if (state.project.binding) decideOptions.bindingKey = state.project.binding.key;
  if (options.presetsPath) decideOptions.presetsPath = options.presetsPath;

  return decideProjectKey(state.project.root, decideOptions);
}

/**
 * A repository key and an explicit `--project` that disagree. Personal
 * sources are not conflicts: explicit already beats them in decideProjectKey,
 * and a stale binding is repaired rather than reported.
 */
function keyConflict(
  state: SetupState,
  options: PlanOptions,
  resolved: { key: string; source: KeySource },
): { requested: KeyOrigin; existing: KeyOrigin } | undefined {
  const explicit = options.explicitKey?.trim();
  if (!explicit) return undefined;
  const repository = state.project.key;
  if (!repository || repository === explicit) return undefined;
  void resolved;
  return {
    requested: { key: explicit, source: "explicit" },
    existing: { key: repository, source: "repository" },
  };
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
