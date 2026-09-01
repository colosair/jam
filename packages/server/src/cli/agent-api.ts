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
import { hostRegistration, type HostRunner } from "../bootstrap/host-mcp.js";
import { checkLiveToolset, type ToolsetProbe } from "../bootstrap/live-toolset.js";
import { SERVER_VERSION } from "@jam-mcp/launcher";
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
  /** Injected by tests so doctor never launches a real MCP server to read its tools. */
  toolsetProbe?: ToolsetProbe;
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
    plan.code === "JAM_BINDINGS_UNREADABLE" ||
    plan.code === "JAM_PROJECT_KEY_CONFLICT"
  ) {
    emitJson({ ...plan, changesApplied: false });
    return 1;
  }

  const result = applySetupPlan(plan, {
    ...(options.home ? { home: options.home } : {}),
    ...(options.runHost ? { runHost: options.runHost } : {}),
  });
  emitJson({
    ...plan,
    status: applyStatus(plan, result.changesApplied),
    changesApplied: result.changesApplied,
  });
  return plan.requiresUserAction ? 1 : 0;
}

/**
 * The status of an apply, after it ran. "already_configured" means nothing
 * was executed; when changes did run the answer is "applied" - reporting
 * "already_configured" alongside changesApplied:true made the two fields
 * contradict each other, and an agent could believe either one.
 */
function applyStatus(plan: SetupPlan, changesApplied: boolean): SetupPlan["status"] | "applied" {
  if (plan.requiresUserAction) return "user_action_required";
  return changesApplied ? "applied" : "already_configured";
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
    plan.code === "JAM_BINDINGS_UNREADABLE" ||
    plan.code === "JAM_PROJECT_KEY_CONFLICT"
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

/**
 * `jam doctor --json`.
 *
 * Three axes, kept apart on purpose. The package on this machine being current
 * says nothing about what the host registration launches, and neither says what
 * the agent can actually call - a stale pin serves an older tool set while every
 * local check passes. Reporting them as one verdict is how a broken setup was
 * reported as ready.
 */
export async function doctorJsonCommand(options: AgentOptions = {}): Promise<number> {
  // detect() already probes the hosts for every non-shared path; doctor wants that.
  const state = detect(options);
  const health = await gateResult(state.project.root);
  const axes = await inspectAxes(state, options);
  // 등록이 아예 없는 것은 결함이 아니다 — 새 머신, 호스트 CLI 없는 CI, 아직 setup 을
  // 안 한 사용자 모두 정상 상태다. 전체 판정을 무너뜨리는 것은 **거짓말하는 상태**뿐:
  // 낡은 핀을 실행 중인 등록(STALE)과, 등록은 맞는데 실제 도구가 다른 경우(MISMATCH).
  const axesOk =
    axes.registration !== "HOST_REGISTRATION_STALE" && axes.live !== "LIVE_TOOLSET_MISMATCH";
  const passed = health.passed && axesOk;
  emitJson({
    status: passed ? "ready" : "failed",
    ...(health.error ? { error: health.error } : {}),
    project: { root: state.project.root, ...(state.project.key ? { key: state.project.key } : {}) },
    axes,
    diagnosis: diagnose(state, axes, health),
    checks: health.checks,
  });
  return passed ? 0 : 1;
}

/**
 * One verdict per thing that can independently be wrong.
 *
 * A single `failed` makes an agent guess whether the credentials, the
 * binding, the runtime, the registration or Jira itself is the problem - and
 * a guess becomes a wrong repair. Each axis carries its own state and, when
 * it is not OK, the check that said so.
 */
type DiagnosisAxis =
  | "credentials"
  | "projectBinding"
  | "runtime"
  | "registration"
  | "liveToolset"
  | "jiraAuthentication"
  | "jiraProjectAccess";

type AxisVerdict = { state: "OK" | "FAILED" | "WARNING" | "UNCHECKED"; detail?: string; code?: string };

function diagnose(
  state: SetupState,
  axes: DoctorAxes,
  health: GateResult,
): Record<DiagnosisAxis, AxisVerdict> {
  const check = (name: string): { ok: boolean; detail?: string } | undefined =>
    health.checks.find((c) => c.name === name);
  const fromCheck = (name: string, code: string): AxisVerdict => {
    const found = check(name);
    if (!found) return { state: "UNCHECKED" };
    return found.ok
      ? { state: "OK", ...(found.detail ? { detail: found.detail } : {}) }
      : { state: "FAILED", code, ...(found.detail ? { detail: found.detail } : {}) };
  };

  // Credentials: this axis answers "are all three fields resolvable, and from
  // where" - the snapshot knows that. Whether Jira accepts them is a different
  // question with its own axis below, and conflating the two is what made a
  // working "mixed" setup read as broken. "mixed" is never a failure here.
  const credentialCheck = check("Credentials present");
  const mixed = state.credentials.source === "mixed";
  const credentials: AxisVerdict = !state.credentials.present
    ? {
        state: "FAILED",
        code: "JAM_AUTH_REQUIRED",
        ...(credentialCheck?.detail ? { detail: credentialCheck.detail } : {}),
      }
    : mixed
      ? { state: "WARNING", detail: `fields come from more than one source: ${describeSources(state)}` }
      : { state: "OK", detail: `source ${state.credentials.source}` };

  return {
    credentials,
    projectBinding: state.project.key
      ? { state: "OK", detail: `key ${state.project.key}` }
      : { state: "FAILED", code: "JAM_PROJECT_SELECTION_REQUIRED", detail: "no project key for this workspace" },
    runtime:
      axes.package === "PACKAGE_READY"
        ? { state: "OK", ...(axes.packageVersion ? { detail: axes.packageVersion } : {}) }
        : { state: "FAILED", code: "JAM_RUNTIME_CONFIG_MISSING", ...(state.runtime.error ? { detail: state.runtime.error } : {}) },
    registration:
      axes.registration === "OK"
        ? { state: "OK", ...(axes.registeredVersion ? { detail: axes.registeredVersion } : {}) }
        : axes.registration === "UNREGISTERED"
          ? { state: "UNCHECKED", detail: "no host has a jam entry for this user" }
          : { state: "FAILED", code: axes.registration, ...(axes.detail ? { detail: axes.detail } : {}) },
    liveToolset:
      axes.live === "OK"
        ? { state: "OK" }
        : axes.live === "UNCHECKED"
          ? { state: "UNCHECKED", ...(axes.detail ? { detail: axes.detail } : {}) }
          : {
              state: "FAILED",
              code: axes.live,
              ...(axes.missingTools ? { detail: `missing: ${axes.missingTools.join(", ")}` } : {}),
            },
    jiraAuthentication: fromCheck("Jira authentication", "JAM_JIRA_AUTHENTICATION_FAILED"),
    jiraProjectAccess: fromCheck(
      health.checks.find((c) => c.name.startsWith("JQL search"))?.name ?? "JQL search",
      "JAM_JIRA_PROJECT_ACCESS_FAILED",
    ),
  };
}

/** Field-to-source names only. A credential value never appears here. */
function describeSources(state: SetupState): string {
  const sources = state.credentials.sources;
  if (!sources) return "unknown";
  return Object.entries(sources)
    .map(([field, from]) => `${field}=${from}`)
    .join(", ");
}

type DoctorAxes = {
  /** The runtime this machine would run, and whether it is the one this release pins. */
  package: "PACKAGE_READY" | "PACKAGE_NOT_READY";
  packageVersion?: string;
  /** What the host CLIs have registered for this user. */
  registration: "OK" | "HOST_REGISTRATION_STALE" | "UNREGISTERED" | "HOST_UNREACHABLE";
  registeredVersion?: string;
  /** What the registered command actually serves. Only asked when there is one. */
  live: "OK" | "LIVE_TOOLSET_MISMATCH" | "UNREACHABLE" | "UNCHECKED";
  missingTools?: string[];
  detail?: string;
};

async function inspectAxes(state: SetupState, options: AgentOptions): Promise<DoctorAxes> {
  const packageVersion = state.runtime.version;
  const axes: DoctorAxes = {
    package: packageVersion === SERVER_VERSION ? "PACKAGE_READY" : "PACKAGE_NOT_READY",
    ...(packageVersion ? { packageVersion } : {}),
    registration: "UNREGISTERED",
    live: "UNCHECKED",
  };

  const hosts = state.hosts.filter((host) => host.cliAvailable);
  if (state.hosts.length > 0 && hosts.length === 0) {
    return { ...axes, registration: "HOST_UNREACHABLE", detail: "no host CLI answered" };
  }
  const registered = hosts.find((host) => host.hasJamEntry);
  if (!registered) return axes;

  axes.registration = registered.entryStale ? "HOST_REGISTRATION_STALE" : "OK";
  if (registered.entryVersion) axes.registeredVersion = registered.entryVersion;

  // A stale entry has already answered the question the live check would ask,
  // and asking it means launching that older release. Repair first.
  if (registered.entryStale) return axes;

  // Launch what is actually registered: a bare entry runs the global `jam`,
  // an npx pin runs the pinned launcher. Testing the other one would prove
  // nothing about the entry the agent uses.
  const registration = hostRegistration(registered.id, { bare: registered.entryBare === true });
  const launch = registration ? launcherArgv(registration.args) : null;
  if (!launch) return { ...axes, live: "UNCHECKED", detail: "could not read the registered command" };

  const result = await checkLiveToolset(launch, options.toolsetProbe);
  axes.live = result.verdict === "OK" ? "OK" : result.verdict;
  if (result.missing && result.missing.length > 0) axes.missingTools = result.missing;
  if (result.detail) axes.detail = result.detail;
  return axes;
}

/** The registration argv carries the launch command after `--`. */
function launcherArgv(args: string[]): { command: string; args: string[] } | null {
  const at = args.indexOf("--");
  if (at < 0 || args.length <= at + 1) return null;
  return { command: args[at + 1]!, args: args.slice(at + 2) };
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
    // Which field came from where. Names only - a value never appears.
    ...(credentials.sources ? { sources: credentials.sources } : {}),
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
