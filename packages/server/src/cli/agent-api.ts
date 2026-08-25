import { runHealthGate } from "../bootstrap/boot-health-gate.js";
import { listVisibleProjects } from "../bootstrap/jira-projects.js";
import { applySetupPlan } from "../bootstrap/setup-apply.js";
import { computeSetupPlan, type SetupPlan } from "../bootstrap/setup-plan.js";
import { detectSetupState, type SetupState } from "../bootstrap/setup-state.js";
import { buildDeps } from "../deps.js";
import { toJamError } from "../domain/errors.js";

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
  migrate?: boolean;
};

export function emitJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function detect(options: AgentOptions): SetupState {
  return detectSetupState({
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.home ? { home: options.home } : {}),
  });
}

function planFrom(state: SetupState, options: AgentOptions): SetupPlan {
  return computeSetupPlan(state, {
    ...(options.explicitKey ? { explicitKey: options.explicitKey } : {}),
    ...(options.migrate ? { migrate: options.migrate } : {}),
  });
}

/** Enrich a selection-required plan with the projects the account can see. */
async function withProjects(plan: SetupPlan): Promise<SetupPlan> {
  if (plan.code !== "JAM_PROJECT_SELECTION_REQUIRED") return plan;
  const { projects } = await listVisibleProjects();
  return projects.length > 0 ? { ...plan, projects } : plan;
}

/**
 * `jam setup plan --json` - what setup would do, having done nothing.
 */
export async function setupPlanCommand(options: AgentOptions = {}): Promise<number> {
  const plan = await withProjects(planFrom(detect(options), options));
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
    emitJson({ ...(await withProjects(plan)), changesApplied: false });
    return 1;
  }
  if (plan.code === "JAM_PROJECT_CONFIG_INVALID" || plan.code === "JAM_MCP_CONFIG_UNREADABLE") {
    emitJson({ ...plan, changesApplied: false });
    return 1;
  }

  const result = applySetupPlan(plan);
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
    emitJson({ ...(await withProjects(plan)), changesApplied: false });
    return 1;
  }
  if (plan.code === "JAM_PROJECT_CONFIG_INVALID" || plan.code === "JAM_MCP_CONFIG_UNREADABLE") {
    emitJson({ ...plan, changesApplied: false });
    return 1;
  }

  const { changesApplied } = applySetupPlan(plan);

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
    const deps = await buildDeps({ cwd: root, bootstrap: false });
    const gate = await runHealthGate(deps, "full");
    return { passed: gate.passed, checks: gate.checks };
  } catch (err) {
    return { passed: false, checks: [], error: toJamError(err).message };
  }
}
