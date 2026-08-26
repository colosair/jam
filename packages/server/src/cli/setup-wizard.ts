import { writeRuntimeConfig, type RuntimeMode } from "@jam-mcp/launcher";
import { runHealthGate } from "../bootstrap/boot-health-gate.js";
import { authLoginCommand } from "./auth.js";
import { listVisibleProjects } from "../bootstrap/jira-projects.js";
import {
  checkMigrationTarget,
  computeSetupPlanWithPreflight,
} from "../bootstrap/migration-target.js";
import { LAUNCHER_PACKAGE_SPEC } from "../bootstrap/mcp-config-merger.js";
import { applySetupPlan } from "../bootstrap/setup-apply.js";
import { computeSetupPlan, type SetupPlan } from "../bootstrap/setup-plan.js";
import { detectSetupState, type SetupState } from "../bootstrap/setup-state.js";
import { buildDeps } from "../deps.js";
import { toJamError } from "../domain/errors.js";
import type { CredentialPort } from "../ports/credentials.port.js";
import type { JiraReadPort } from "../ports/jira-read.port.js";
import type { AuthOptions } from "./auth.js";
import type { HostRunner } from "../bootstrap/host-mcp.js";
import { CancelledError, reportPromptError, Ui } from "./ui.js";

export type WizardOptions = {
  cwd?: string;
  home?: string;
  explicitKey?: string;
  /** `--shared`: adopt JAM for the team by writing into the repository. */
  shared?: boolean;
  /** Injected by tests so no test ever registers JAM with a real host. */
  runHost?: HostRunner;
  migrate?: boolean;
  ui?: Ui;
  /**
   * Injected by tests. Without these the wizard reads the machine it runs on -
   * the real keychain through `detectSetupState`, the real Jira through
   * `listVisibleProjects` and the health gate, and the real `JAM_PROJECT_KEY`
   * through the plan. Production passes none of them and behaves as before.
   */
  credentials?: CredentialPort;
  jira?: JiraReadPort;
  env?: NodeJS.ProcessEnv;
  auth?: AuthOptions;
};

/**
 * `jam setup`, the human path.
 *
 * Runs the same detect -> plan -> apply -> verify core the agent API uses; the
 * only difference is presentation and the ability to ask. Anything that can be
 * determined is determined - the wizard never asks a question it already knows
 * the answer to, and never re-walks steps that are already done.
 */
export async function runSetupWizard(options: WizardOptions = {}): Promise<number> {
  const ui = options.ui ?? new Ui();
  const cwd = options.cwd ?? process.cwd();

  try {
    let state = detectSetupState(detectOptions(options, cwd));

    // Everything already in place: show status and offer actions rather than
    // marching through a wizard the user has completed before.
    if (isFullyConfigured(state)) {
      return await runStatusMenu(ui, state, options);
    }

    ui.line();
    ui.line(`${"◆"} JAM`);
    ui.line("  Jira Agent MCP");
    ui.line();
    ui.line("  Configure JAM for this machine.");

    state = await ensureRuntime(ui, state, options);
    state = await ensureCredentials(ui, state, options);

    const outcome = await wireProject(ui, state, options);
    if (outcome !== 0) return outcome;

    return await verify(ui, state.project.root, options);
  } catch (err) {
    // Not a JAM or Jira fault - there is simply nobody to answer, or the person
    // changed their mind. Shared with `jam auth login` so both say the same
    // thing.
    const code = reportPromptError(err, ui);
    if (code === undefined) throw err;
    return code;
  }
}

/**
 * "Nothing left to do" depends on the scope this workspace is actually set up
 * in: a personal user has a binding and no repository files, and telling them
 * their setup is incomplete because `.mcp.json` is missing would be wrong.
 */
function isFullyConfigured(state: SetupState): boolean {
  const wired = state.mcp.hasJamEntry || Boolean(state.project.binding);
  return (
    state.runtime.configured &&
    !state.runtime.error &&
    state.credentials.present &&
    Boolean(state.project.key || state.project.binding) &&
    wired
  );
}

type MenuAction = "health" | "runtime" | "auth" | "repair" | "exit";

async function runStatusMenu(
  ui: Ui,
  state: SetupState,
  options: WizardOptions,
): Promise<number> {
  ui.line();
  ui.line("◆ JAM");
  ui.line();
  ui.success("Runtime", describeRuntime(state));
  ui.success("Authentication", `configured · ${state.credentials.source}`);
  ui.success("Project", state.project.key ?? "");
  ui.success("MCP", "ready");
  ui.line();
  ui.line("Everything is configured.");

  if (!ui.interactive) {
    ui.next("Run `jam doctor` to verify Jira connectivity.");
    return 0;
  }

  ui.line();
  const action = await ui.select<MenuAction>(
    "What do you want to do?",
    [
      { value: "health", label: "Run health check", hint: "Verify Jira connectivity now." },
      { value: "runtime", label: "Change runtime", hint: "Switch between the package and a local checkout." },
      { value: "auth", label: "Re-authenticate", hint: "Replace the stored credentials." },
      { value: "repair", label: "Repair project setup", hint: "Re-apply project.yaml and .mcp.json wiring." },
      { value: "exit", label: "Exit", hint: "" },
    ],
    "Run: jam setup plan --json",
  );

  switch (action) {
    case "health":
      return verify(ui, state.project.root, options);
    case "runtime":
      await chooseRuntime(ui, options);
      return 0;
    case "auth":
      ui.line();
      return await authLoginCommand({ ui, ...options.auth });
    case "repair": {
      const plan = computeSetupPlanWithPreflight(state, planOptions(options), probe(ui));
      const applied = applySetupPlan(plan, {
      ...(options.home ? { home: options.home } : {}),
      ...(options.runHost ? { runHost: options.runHost } : {}),
    });
      ui.line();
      if (applied.changesApplied) ui.success("Project wiring repaired");
      else ui.success("Nothing to repair");
      if (reportMigrationRefused(ui, plan)) return 1;
      return verify(ui, state.project.root, options);
    }
    case "exit":
      return 0;
  }
}

async function ensureRuntime(
  ui: Ui,
  state: SetupState,
  options: WizardOptions,
): Promise<SetupState> {
  if (state.runtime.configured && !state.runtime.error) {
    ui.section("Runtime");
    ui.success("Runtime configured", describeRuntime(state));
    return state;
  }

  ui.section("Runtime");
  if (state.runtime.error) {
    ui.warn("The configured runtime is not usable", state.runtime.error);
  }

  await chooseRuntime(ui, options);
  return detectSetupState(detectOptions(options));
}

async function chooseRuntime(ui: Ui, options: WizardOptions): Promise<void> {
  // Wording is behavioural on purpose. "Package" and "development" are JAM's
  // internal vocabulary; what a user knows is whether they are using JAM or
  // working on it.
  const mode = await ui.select<RuntimeMode>(
    "How will you use JAM?",
    [
      {
        value: "package",
        label: "Use JAM",
        hint: "Run the published JAM release. Recommended for most users.",
      },
      { value: "development", label: "Develop JAM", hint: "Run a local source checkout." },
    ],
    "Run: jam runtime use package",
  );

  if (mode === "package") {
    writeRuntimeConfig({ version: 1, runtime: { mode: "package" } }, options.home);
    ui.line();
    ui.success("Runtime configured", "package");
    return;
  }

  ui.line();
  ui.next("Point JAM at your checkout:  jam runtime use development <path>");
  throw new CancelledError();
}

/**
 * Report the credentials, or offer to store some - and then look again.
 *
 * A step, not a printout: `jam auth login` changes the machine, so continuing
 * with the snapshot taken before it would carry `credentials.present = false`
 * into the plan and the health gate, and the wizard would report a missing
 * credential it had just watched the user supply.
 */
async function ensureCredentials(
  ui: Ui,
  state: SetupState,
  options: WizardOptions,
): Promise<SetupState> {
  ui.section("Authentication");

  if (state.credentials.present) {
    // Found and usable - stating it is enough. Asking "use these?" would be a
    // question with one sensible answer.
    ui.success(
      "Jira credentials found",
      `${state.credentials.email} · ${state.credentials.baseUrl} (${state.credentials.source})`,
    );
    return state;
  }

  if (!ui.interactive) {
    // Nobody to ask. Setup still wires the project and stops at the human step.
    ui.warn("Jira credentials are not configured");
    ui.line("  Run `jam auth login`, or set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN.");
    return state;
  }

  ui.warn("Jira credentials are not configured");
  if ((await authLoginCommand({ ui, ...options.auth })) !== 0) return state;

  // Look again. `auth login` changed the machine, and every later step reads
  // this snapshot - carrying the stale one forward would plan and verify
  // against a credential the user just watched themselves supply.
  const fresh = detectSetupState(detectOptions(options));
  if (fresh.credentials.present) {
    // Reported from the refreshed state on purpose: this line is what says the
    // rest of setup is working from the new credential, and where it resolves
    // from - which is not always the store, if an export is shadowing it.
    ui.success(
      "Jira credentials found",
      `${fresh.credentials.email} · ${fresh.credentials.baseUrl} (${fresh.credentials.source})`,
    );
  }
  return fresh;
}

async function wireProject(ui: Ui, state: SetupState, options: WizardOptions): Promise<number> {
  ui.section("Project");

  const plan = computeSetupPlanWithPreflight(state, planOptions(options), probe(ui));

  if (
    plan.code === "JAM_PROJECT_CONFIG_INVALID" ||
    plan.code === "JAM_MCP_CONFIG_UNREADABLE" ||
    plan.code === "JAM_BINDINGS_UNREADABLE"
  ) {
    ui.failure(
      plan.code === "JAM_PROJECT_CONFIG_INVALID"
        ? "The project's .jira-agent/project.yaml could not be parsed"
        : plan.code === "JAM_BINDINGS_UNREADABLE"
          ? "Your ~/.jam/projects.yaml could not be read"
          : "The project's .mcp.json is not valid JSON",
    );
    ui.line("  Fix it and re-run - JAM will not overwrite it.");
    return 1;
  }

  if (plan.code === "JAM_PROJECT_SELECTION_REQUIRED") {
    return reportSelectionRequired(ui, state, options);
  }

  if (plan.changes.length === 0) {
    ui.success("Project already wired", state.project.key ?? "");
  } else {
    for (const change of applySetupPlan(plan, {
      ...(options.home ? { home: options.home } : {}),
      ...(options.runHost ? { runHost: options.runHost } : {}),
    })
      .applied) {
      if (change.target === "personal-binding") {
        ui.success(
          change.previousKey ? "Workspace re-bound" : "Workspace bound",
          change.previousKey ? `${change.previousKey} → ${change.key}` : change.key,
        );
        ui.line("  Recorded for you only - the repository was not touched.");
      } else if (change.target === "host-mcp") {
        ui.success("Registered with", change.host);
      } else if (change.target === "project-config") {
        ui.success("Project configured", `${change.key} · from ${change.keySource}`);
      } else if (change.type === "merge") {
        ui.success(
          "MCP entry added",
          change.preserveExisting.length > 0
            ? `${change.preserveExisting.length} other server(s) preserved`
            : "",
        );
      } else {
        ui.success("MCP config written");
      }
    }
  }

  if (reportMigrationRefused(ui, plan)) return 1;
  return 0;
}

/**
 * The registry probe blocks, so it gets a pending line rather than a spinner -
 * a spinner wrapped around synchronous work prints a frame that never animates.
 * Building it into the check means the line appears only when a probe actually
 * happens, never on the paths that skip it.
 */
function probe(ui: Ui): () => ReturnType<typeof checkMigrationTarget> {
  return () => {
    ui.pending(`Checking ${LAUNCHER_PACKAGE_SPEC} on npm...`);
    return checkMigrationTarget();
  };
}

/** True when a requested migration was refused, so the caller stops here. */
function reportMigrationRefused(ui: Ui, plan: SetupPlan): boolean {
  if (plan.code !== "JAM_MIGRATION_TARGET_UNAVAILABLE") return false;
  ui.failure("Migration target is not available from the configured npm registry");
  if (plan.migrationTarget?.detail) ui.line(`  ${plan.migrationTarget.detail}`);
  ui.line("  Existing .mcp.json was left unchanged.");
  return true;
}

async function reportSelectionRequired(
  ui: Ui,
  state: SetupState,
  options: WizardOptions,
): Promise<number> {
  ui.failure("No Jira project key could be determined safely");
  ui.line(`  Nothing under ${state.project.root} says which Jira project this is,`);
  ui.line("  and JAM does not guess one from a directory or repository name.");

  // Network call, so this one earns a spinner.
  const { projects, truncated, error } = await ui.spin("Listing Jira projects...", () =>
    listVisibleProjects(options.credentials),
  );

  ui.line();
  if (error) {
    ui.line(`  ${error}`);
  } else if (projects.length === 0) {
    ui.line("  This Jira account cannot see any projects.");
  } else {
    ui.line("  Projects visible to this account:");
    for (const p of projects) ui.line(`    ${p.key.padEnd(14)} ${p.name}`);
    if (truncated) ui.line("    ...(more not shown)");
  }

  ui.next("Re-run:  jam setup --project <KEY>");
  return 1;
}

async function verify(ui: Ui, root: string, options: WizardOptions): Promise<number> {
  ui.section("Verify");

  let deps: Awaited<ReturnType<typeof buildDeps>>;
  try {
    deps = await buildDeps({
      cwd: root,
      keyFallback: "optional",
      ...(options.credentials ? { credentials: options.credentials } : {}),
      ...(options.jira ? { jira: options.jira } : {}),
    });
  } catch (err) {
    ui.failure("Project config", toJamError(err).message);
    return 1;
  }

  const gate = await ui.spin("Checking Jira access...", () => runHealthGate(deps, "full"));

  for (const check of gate.checks) {
    if (check.ok) ui.success(check.name, check.detail);
    else if (check.fatal) ui.failure(check.name, check.detail);
    else ui.warn(check.name, check.detail);
  }

  ui.line();
  if (gate.passed) {
    ui.success("JAM ready");
    ui.next("Start Claude Code or Codex and use JAM.");
    return 0;
  }
  ui.failure("Setup is incomplete");
  return 1;
}

function describeRuntime(state: SetupState): string {
  const version = state.runtime.version ? ` · ${state.runtime.version}` : "";
  return state.runtime.mode === "development"
    ? `development · ${state.runtime.source}`
    : `package${version}`;
}

function planOptions(options: WizardOptions): Parameters<typeof computeSetupPlan>[1] {
  return {
    ...(options.shared ? { shared: options.shared } : {}),
    ...(options.explicitKey ? { explicitKey: options.explicitKey } : {}),
    ...(options.migrate ? { migrate: options.migrate } : {}),
    ...(options.env ? { env: options.env } : {}),
  };
}

/** Detect options, with the test seams threaded through. */
function detectOptions(options: WizardOptions, cwd?: string) {
  return {
    cwd: cwd ?? options.cwd ?? process.cwd(),
    ...(options.home ? { home: options.home } : {}),
    probeHosts: !options.shared,
    ...(options.runHost ? { runHost: options.runHost } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
  };
}

export type { SetupPlan };
