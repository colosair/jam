import { runHealthGate } from "../bootstrap/boot-health-gate.js";
import { listVisibleProjects } from "../bootstrap/jira-projects.js";
import {
  computeSetupPlanWithPreflight,
  type MigrationTarget,
} from "../bootstrap/migration-target.js";
import { applySetupPlan } from "../bootstrap/setup-apply.js";
import { type SetupPlan } from "../bootstrap/setup-plan.js";
import { detectSetupState, type SetupState } from "../bootstrap/setup-state.js";
import { buildDeps } from "../deps.js";
import { toJamError } from "../domain/errors.js";
import type { CredentialPort } from "../ports/credentials.port.js";
import type { HostRunner } from "../bootstrap/host-mcp.js";
import type { GitRemoteFn } from "../bootstrap/workspace-identity.js";

/**
 * The machine-readable half of setup.
 *
 * Everything here shares the detect/plan/apply core with the human wizard -
 * only the interface differs. An agent gets structured status codes instead of
 * prose so it never has to infer intent from an error message, and never has
 * to assemble JAM's config files itself.
 *
 * Contract, enforced by tests:
 *   stdout - valid JSON and nothing else, no ANSI, no prompts
 *   stderr - diagnostics only
 */

export type AgentOptions = {
  cwd?: string;
  home?: string;
  explicitKey?: string;
  /** `--shared`: adopt JAM for the team, writing into the repository. */
  shared?: boolean;
  migrate?: boolean;
  /** Injected by tests so a plan never depends on the machine's JIRA_* env. */
  credentials?: CredentialPort;
  /** Injected by tests so a plan never depends on the machine's JAM_PROJECT_KEY. */
  env?: NodeJS.ProcessEnv;
  /** Injected by tests so a plan never shells out to npm to verify a migration target. */
  migrationTarget?: MigrationTarget;
  /** Injected by tests so identity never depends on the checkout under test. */
  git?: GitRemoteFn;
  /** Injected by tests so no test ever registers JAM with a real host. */
  runHost?: HostRunner;
};

export function emitJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function detect(options: AgentOptions): SetupState {
  return detectSetupState({
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.home ? { home: options.home } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.git ? { git: options.git } : {}),
    probeHosts: !options.shared,
    ...(options.runHost ? { runHost: options.runHost } : {}),
  });
}

function planFrom(state: SetupState, options: AgentOptions): SetupPlan {
  return computeSetupPlanWithPreflight(state, {
    ...(options.shared ? { shared: options.shared } : {}),
    ...(options.explicitKey ? { explicitKey: options.explicitKey } : {}),
    ...(options.migrate ? { migrate: options.migrate } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.migrationTarget ? { migrationTarget: options.migrationTarget } : {}),
  });
}

/** Enrich a selection-required plan with the projects the account can see. */
async function withProjects(plan: SetupPlan, options: AgentOptions): Promise<SetupPlan> {
  if (plan.code !== "JAM_PROJECT_SELECTION_REQUIRED") return plan;
  const { projects } = await listVisibleProjects(options.credentials);
  return projects.length > 0 ? { ...plan, projects } : plan;
}

/**
 * `jam setup plan --json` - what setup would do, having done nothing.
 */
export async function setupPlanCommand(options: AgentOptions = {}): Promise<number> {
  const plan = await withProjects(planFrom(detect(options), options), options);
  emitJson({ ...plan, changesApplied: false });
  return plan.requiresUserAction ? 1 : 0;
}

/**
 * `jam setup apply --non-interactive --json` - execute a freshly computed plan.
 *
 * Applies whatever the plan safely can even when a human step remains, and
 * says so via `changesApplied`. A missing credential should not leave a
 * project half-wired.
 */
export async function setupApplyCommand(options: AgentOptions = {}): Promise<number> {
  const state = detect(options);
  const plan = planFrom(state, options);

  if (plan.code === "JAM_PROJECT_SELECTION_REQUIRED") {
    emitJson({ ...(await withProjects(plan, options)), changesApplied: false });
    return 1;
  }
  if (
    plan.code === "JAM_PROJECT_CONFIG_INVALID" ||
    plan.code === "JAM_MCP_CONFIG_UNREADABLE" ||
    plan.code === "JAM_BINDINGS_UNREADABLE"
  ) {
    emitJson({ ...plan, changesApplied: false });
    return 1;
  }

  const result = applySetupPlan(plan, {
    ...(options.home ? { home: options.home } : {}),
    ...(options.runHost ? { runHost: options.runHost } : {}),
  });
  emitJson({ ...plan, status: applyStatus(plan), changesApplied: result.changesApplied });
  return plan.requiresUserAction ? 1 : 0;
}

function applyStatus(plan: SetupPlan): SetupPlan["status"] {
  return plan.requiresUserAction ? "user_action_required" : "already_configured";
}

/**
 * `jam setup --agent` - one shot: detect, plan, apply what is safe, verify.
 *
 * Stops only where a person is genuinely required (choosing a Jira project,
 * authenticating), and reports exactly how far it got.
 */
export async function setupAgentCommand(options: AgentOptions = {}): Promise<number> {
  const state = detect(options);
  const plan = planFrom(state, options);

  if (plan.code === "JAM_PROJECT_SELECTION_REQUIRED") {
    emitJson({ ...(await withProjects(plan, options)), changesApplied: false });
    return 1;
  }
  if (
    plan.code === "JAM_PROJECT_CONFIG_INVALID" ||
    plan.code === "JAM_MCP_CONFIG_UNREADABLE" ||
    plan.code === "JAM_BINDINGS_UNREADABLE"
  ) {
    emitJson({ ...plan, changesApplied: false });
    return 1;
  }

  const { changesApplied } = applySetupPlan(plan, {
    ...(options.home ? { home: options.home } : {}),
    ...(options.runHost ? { runHost: options.runHost } : {}),
  });

  if (plan.requiresUserAction) {
    emitJson({ ...plan, changesApplied });
    return 1;
  }

  const health = await gateResult(state.project.root);
  emitJson({
    status: health.passed ? "ready" : "verification_failed",
    changesApplied,
    project: plan.project,
    checks: health.checks,
  });
  return health.passed ? 0 : 1;
}

/** `jam doctor --json`. */
export async function doctorJsonCommand(options: AgentOptions = {}): Promise<number> {
  const state = detect(options);
  const health = await gateResult(state.project.root);
  emitJson({
    status: health.passed ? "ready" : "failed",
    ...(health.error ? { error: health.error } : {}),
    project: { root: state.project.root, ...(state.project.key ? { key: state.project.key } : {}) },
    checks: health.checks,
  });
  return health.passed ? 0 : 1;
}

/**
 * `jam auth status --json` - presence and origin only.
 *
 * Never returns the credential itself. An agent needs to know whether
 * authentication is configured, not what it is.
 */
export function authStatusCommand(options: AgentOptions = {}): number {
  const { credentials } = detect(options);
  emitJson({
    status: credentials.present ? "configured" : "not_configured",
    ...(credentials.present ? {} : { code: "JAM_AUTH_REQUIRED" }),
    source: credentials.source,
    ...(credentials.email ? { email: credentials.email } : {}),
    ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
  });
  return credentials.present ? 0 : 1;
}

type GateResult = {
  passed: boolean;
  checks: { name: string; ok: boolean; fatal: boolean; detail?: string }[];
  error?: string;
};

async function gateResult(root: string): Promise<GateResult> {
  try {
    const deps = await buildDeps({ cwd: root, keyFallback: "optional" });
    const gate = await runHealthGate(deps, "full");
    return { passed: gate.passed, checks: gate.checks };
  } catch (err) {
    return { passed: false, checks: [], error: toJamError(err).message };
  }
}
