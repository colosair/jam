import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runHealthGate } from "../bootstrap/boot-health-gate.js";
import {
  describeHostCommand,
  hostRegistration,
  type HostRunner,
} from "../bootstrap/host-mcp.js";
import { listVisibleProjects } from "../bootstrap/jira-projects.js";
import { computeSetupPlanWithPreflight } from "../bootstrap/migration-target.js";
import { applySetupPlan } from "../bootstrap/setup-apply.js";
import { type SetupPlan } from "../bootstrap/setup-plan.js";
import { detectSetupState, type SetupState } from "../bootstrap/setup-state.js";
import { toJamError } from "../domain/errors.js";
import { buildDeps } from "../deps.js";

export type SetupOptions = {
  cwd?: string;
  /** `--project KEY` */
  explicitKey?: string;
  /**
   * `--shared`: adopt JAM for the team, writing `.jira-agent/project.yaml` and
   * `.mcp.json`. Without it setup records the binding for this user only and
   * leaves the repository untouched.
   */
  shared?: boolean;
  /** `--migrate`: rewrite a legacy jam entry in .mcp.json. */
  migrate?: boolean;
  /** Injected by tests to isolate ~/.jam. */
  home?: string;
  /** Injected by tests so no test ever registers JAM with a real host. */
  runHost?: HostRunner;
};

const line = (text: string) => process.stdout.write(`${text}\n`);

/**
 * `jam setup`: the one command a teammate should ever need to run by hand.
 *
 * Runs the same detect -> plan -> apply -> verify core the agent API uses, so
 * a human and an agent cannot end up with different notions of what setup does
 * or what it is allowed to touch.
 */
export async function setup(options: SetupOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();

  if (isJamCheckout(cwd)) {
    const installed = await installAndBuild(cwd);
    if (installed !== 0) return installed;
  }

  const state = detectSetupState({
    cwd,
    ...(options.home ? { home: options.home } : {}),
    // Personal setup registers JAM with this machine's coding agents, so it
    // has to know which of them exist. Doctor has no such need and does not
    // pay for the probe.
    probeHosts: !options.shared,
    ...(options.runHost ? { runHost: options.runHost } : {}),
  });
  const plan = computeSetupPlanWithPreflight(state, {
    ...(options.shared ? { shared: options.shared } : {}),
    ...(options.explicitKey ? { explicitKey: options.explicitKey } : {}),
    ...(options.migrate ? { migrate: options.migrate } : {}),
  });

  if (plan.code === "JAM_PROJECT_SELECTION_REQUIRED") {
    return reportProjectSelectionRequired(state.project.root);
  }
  if (
    plan.code === "JAM_PROJECT_CONFIG_INVALID" ||
    plan.code === "JAM_MCP_CONFIG_UNREADABLE" ||
    plan.code === "JAM_BINDINGS_UNREADABLE"
  ) {
    line(`[FAIL] ${describeBlockingCode(plan)}`);
    return 1;
  }

  reportApplied(
    applySetupPlan(plan, {
      ...(options.home ? { home: options.home } : {}),
      ...(options.runHost ? { runHost: options.runHost } : {}),
    }).applied,
    plan,
  );
  reportBindingDisagreement(state);
  reportUnreachableHosts(state);

  // The rewrite the user asked for is the thing that failed, so it is reported
  // before anything else - and reported as a stop, not a warning: continuing to
  // the health gate would imply the migration happened.
  if (plan.code === "JAM_MIGRATION_TARGET_UNAVAILABLE") {
    line("");
    line("[FAIL] Migration target is not available from the configured npm registry.");
    line(`       ${plan.migrationTarget?.detail ?? "The target could not be verified."}`);
    line("       Existing .mcp.json was left unchanged.");
    return 1;
  }

  if (plan.code === "JAM_AUTH_REQUIRED") {
    line("");
    line("[FAIL] Jira authentication is not configured for this user.");
    line("       Run `jam auth login`, then re-run `jam doctor`.");
    line("       Or set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN to override.");
    return 1;
  }
  if (plan.code === "JAM_RUNTIME_CONFIG_MISSING") {
    line("");
    line("[WARN] No JAM runtime is configured for this user yet.");
    line("       Run: jam runtime use package");
  }

  line("\n> jam doctor\n");
  return verify(state.project.root);
}

async function verify(root: string): Promise<number> {
  let deps: Awaited<ReturnType<typeof buildDeps>>;
  try {
    deps = await buildDeps({ cwd: root, keyFallback: "optional" });
  } catch (err) {
    line(`[FAIL] Project config - ${toJamError(err).message}`);
    return 1;
  }

  const gate = await runHealthGate(deps, "full");
  for (const check of gate.checks) {
    line(`${check.ok ? "[OK]  " : "[FAIL]"} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
  }
  return gate.passed ? 0 : 1;
}

function reportApplied(applied: ReturnType<typeof applySetupPlan>["applied"], plan: SetupPlan): void {
  if (applied.length === 0) {
    line("[OK]   Project already wired - nothing to change");
    return;
  }
  for (const change of applied) {
    if (change.target === "personal-binding") {
      const what = change.previousKey
        ? `re-bound from ${change.previousKey} to ${change.key}`
        : `bound to ${change.key} (from ${change.keySource})`;
      line(`[OK]   ${change.path} - this workspace ${what}`);
      line("       Nothing was written to the repository. Use --shared to adopt JAM for the team.");
      continue;
    }
    if (change.target === "host-mcp") {
      line(`[OK]   ${change.host} - jam registered for this user`);
      continue;
    }
    if (change.target === "project-config") {
      line(`[OK]   ${change.path} created - project.key = ${change.key} (from ${change.keySource})`);
      continue;
    }
    if (change.type === "create") {
      line(`[OK]   ${change.path} - created`);
    } else if (change.type === "merge") {
      const preserved = change.preserveExisting.length;
      line(
        `[OK]   ${change.path} - added jam entry` +
          (preserved > 0 ? ` (${preserved} other MCP server(s) preserved)` : ""),
      );
    } else {
      line(`[OK]   ${change.path} - migrated jam entry`);
    }
  }
  void plan;
}

function describeBlockingCode(plan: SetupPlan): string {
  if (plan.code === "JAM_PROJECT_CONFIG_INVALID") {
    return "The project's .jira-agent/project.yaml could not be parsed. Fix it and re-run.";
  }
  if (plan.code === "JAM_BINDINGS_UNREADABLE") {
    return "Your ~/.jam/projects.yaml could not be read. Fix or remove it and re-run - JAM will not overwrite it.";
  }
  return "The project's .mcp.json is not valid JSON. Fix it and re-run - JAM will not overwrite it.";
}

/**
 * A host JAM could not reach is reported, never guessed at: the command is
 * printed so the person can run it, and nothing is claimed to have happened.
 */
function reportUnreachableHosts(state: SetupState): void {
  for (const host of state.hosts) {
    if (host.cliAvailable) continue;
    const registration = hostRegistration(host.id);
    if (!registration) continue;
    line(`[WARN] ${host.id} was not reachable, so JAM was not registered with it.`);
    line(`       If you use it, run: ${describeHostCommand(registration)}`);
  }
}

/**
 * A committed project key and a personal binding can disagree - normally
 * because the team adopted JAM after someone bound the repo. The file wins,
 * and saying so is better than silently ignoring one of them or deleting the
 * other on the user's behalf.
 */
function reportBindingDisagreement(state: SetupState): void {
  const bound = state.project.binding?.key;
  if (!bound || !state.project.key || bound === state.project.key) return;
  line(
    `[WARN] Personal binding says ${bound}; ${state.project.configPath ?? "the project config"} says ${state.project.key} - the project file wins.`,
  );
}

/** The JAM monorepo checkout itself, where setup should also install and build. */
function isJamCheckout(cwd: string): boolean {
  return (
    existsSync(join(cwd, "package.json")) &&
    existsSync(join(cwd, "packages", "server", "src", "index.ts"))
  );
}

async function installAndBuild(root: string): Promise<number> {
  for (const step of [
    { name: "Install dependencies", args: ["ci"] },
    { name: "Build", args: ["run", "build"] },
  ]) {
    line(`\n> npm ${step.args.join(" ")}`);
    const res = spawnSync("npm", step.args, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (res.status !== 0) {
      line(`[FAIL] ${step.name}`);
      return res.status ?? 1;
    }
  }
  return 0;
}

/**
 * No config, and no explicit/env/preset source to decide one from. JAM never
 * guesses a Jira project from a repo or folder name - it shows the operator
 * their options and asks them to say which one, once.
 */
async function reportProjectSelectionRequired(root: string): Promise<number> {
  line(`[FAIL] No .jira-agent/project.yaml under ${root}, and no project key could be determined safely.`);

  const { projects, truncated, error } = await listVisibleProjects();
  if (error) {
    line(`       ${error}`);
  } else if (projects.length === 0) {
    line("       This Jira account cannot see any projects.");
  } else {
    line("       Projects visible to this account:");
    for (const p of projects) line(`         ${p.key}  ${p.name}`);
    if (truncated) line("         ...(more not shown)");
  }

  line("       Re-run: jam setup --project <KEY>");
  return 1;
}
