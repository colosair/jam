import { writeRuntimeConfig, type RuntimeMode } from "@jam-mcp/launcher";
import { runHealthGate } from "../bootstrap/boot-health-gate.js";
import { listVisibleProjects } from "../bootstrap/jira-projects.js";
import { applySetupPlan } from "../bootstrap/setup-apply.js";
import { computeSetupPlan, type SetupPlan } from "../bootstrap/setup-plan.js";
import { detectSetupState, type SetupState } from "../bootstrap/setup-state.js";
import { buildDeps } from "../deps.js";
import { toJamError } from "../domain/errors.js";
import { CancelledError, NonInteractiveError, Ui } from "./ui.js";

export type WizardOptions = {
  cwd?: string;
  home?: string;
  explicitKey?: string;
  migrate?: boolean;
  ui?: Ui;
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
    let state = detectSetupState({ cwd, ...(options.home ? { home: options.home } : {}) });

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
    reportCredentials(ui, state);

    const outcome = await wireProject(ui, state, options);
    if (outcome !== 0) return outcome;

    return await verify(ui, state.project.root);
  } catch (err) {
    if (err instanceof CancelledError) {
      ui.line();
      ui.warn("Cancelled. Nothing was changed.");
      return 130;
    }
    if (err instanceof NonInteractiveError) {
      // Not a JAM or Jira fault - there is simply nobody to answer. Say what
      // to run instead of surfacing this as a diagnostic failure.
      ui.line();
      ui.failure(err.message);
      ui.next(`Run:  ${err.flagHint}`);
      return 1;
    }
    throw err;
  }
}

function isFullyConfigured(state: SetupState): boolean {
  return (
    state.runtime.configured &&
    !state.runtime.error &&
    state.credentials.present &&
    Boolean(state.project.key) &&
    state.mcp.hasJamEntry
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
      { value: "auth", label: "Re-authenticate", hint: "Show how to replace the stored credentials." },
      { value: "repair", label: "Repair project setup", hint: "Re-apply project.yaml and .mcp.json wiring." },
      { value: "exit", label: "Exit", hint: "" },
    ],
    "--json for a non-interactive status",
  );

  switch (action) {
    case "health":
      return verify(ui, state.project.root);
    case "runtime":
      await chooseRuntime(ui, options);
      return 0;
    case "auth":
      ui.line();
      ui.next("Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN, then run `jam doctor`.");
      return 0;
    case "repair": {
      const plan = computeSetupPlan(state, planOptions(options));
      const applied = applySetupPlan(plan);
      ui.line();
      if (applied.changesApplied) ui.success("Project wiring repaired");
      else ui.success("Nothing to repair");
      return verify(ui, state.project.root);
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
  return detectSetupState({
    cwd: options.cwd ?? process.cwd(),
    ...(options.home ? { home: options.home } : {}),
  });
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
        hint: "Run the project-pinned package. Recommended for most users.",
      },
      { value: "development", label: "Develop JAM", hint: "Run a local source checkout." },
    ],
    "jam runtime use package",
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

function reportCredentials(ui: Ui, state: SetupState): void {
  ui.section("Authentication");
  if (state.credentials.present) {
    // Found and usable - stating it is enough. Asking "use these?" would be a
    // question with one sensible answer.
    ui.success(
      "Jira credentials found",
      `${state.credentials.email} · ${state.credentials.baseUrl} (${state.credentials.source})`,
    );
    return;
  }
  ui.warn("Jira credentials are not configured");
  ui.line("  Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN for your user.");
}

async function wireProject(ui: Ui, state: SetupState, options: WizardOptions): Promise<number> {
  ui.section("Project");

  const plan = computeSetupPlan(state, planOptions(options));

  if (plan.code === "JAM_PROJECT_CONFIG_INVALID" || plan.code === "JAM_MCP_CONFIG_UNREADABLE") {
    ui.failure(
      plan.code === "JAM_PROJECT_CONFIG_INVALID"
        ? "The project's .jira-agent/project.yaml could not be parsed"
        : "The project's .mcp.json is not valid JSON",
    );
    ui.line("  Fix it and re-run - JAM will not overwrite it.");
    return 1;
  }

  if (plan.code === "JAM_PROJECT_SELECTION_REQUIRED") {
    return reportSelectionRequired(ui, state);
  }

  if (plan.changes.length === 0) {
    ui.success("Project already wired", state.project.key ?? "");
  } else {
    for (const change of applySetupPlan(plan).applied) {
      if (change.target === "project-config") {
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
  return 0;
}

async function reportSelectionRequired(ui: Ui, state: SetupState): Promise<number> {
  ui.failure("No Jira project key could be determined safely");
  ui.line(`  Nothing under ${state.project.root} says which Jira project this is,`);
  ui.line("  and JAM does not guess one from a directory or repository name.");

  // Network call, so this one earns a spinner.
  const { projects, truncated, error } = await ui.spin("Listing Jira projects...", () =>
    listVisibleProjects(),
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

async function verify(ui: Ui, root: string): Promise<number> {
  ui.section("Verify");

  let deps: Awaited<ReturnType<typeof buildDeps>>;
  try {
    deps = await buildDeps({ cwd: root, bootstrap: false });
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
    ...(options.explicitKey ? { explicitKey: options.explicitKey } : {}),
    ...(options.migrate ? { migrate: options.migrate } : {}),
  };
}

export type { SetupPlan };
