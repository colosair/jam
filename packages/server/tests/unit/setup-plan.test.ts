import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_VERSION } from "@jam-mcp/launcher";
import { LAUNCHER_PACKAGE_SPEC } from "../../src/bootstrap/mcp-config-merger.js";
import {
  checkMigrationTarget,
  computeSetupPlanWithPreflight as computeSharedPlanWithPreflight,
  type MigrationTarget,
  type RunResult,
} from "../../src/bootstrap/migration-target.js";
import { applySetupPlan } from "../../src/bootstrap/setup-apply.js";
import {
  computeSetupPlan as computeScopedPlan,
  type PlanOptions,
  type SetupPlan,
} from "../../src/bootstrap/setup-plan.js";
import { detectSetupState } from "../../src/bootstrap/setup-state.js";
import type { CredentialPort } from "../../src/ports/credentials.port.js";
import { snapshot } from "../helpers.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A project root that looks like a repo but has no JAM wiring yet. */
function bareProject(): string {
  const root = tmp("jam-plan-");
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

function withProjectConfig(root: string, key: string): void {
  mkdirSync(join(root, ".jira-agent"), { recursive: true });
  writeFileSync(
    join(root, ".jira-agent", "project.yaml"),
    ["version: 1", "project:", `  key: ${key}`, ""].join("\n"),
    "utf8",
  );
}

const configuredCredentials: CredentialPort = {
  load: () => ({
    baseUrl: "https://example.atlassian.net",
    email: "user@example.com",
    apiToken: "SECRET",
  }),
  describe: () => ({
    baseUrl: "https://example.atlassian.net",
    email: "user@example.com",
    hasToken: true,
    source: "process",
  }),
};

const missingCredentials: CredentialPort = {
  load: () => {
    throw new Error("no credentials");
  },
  describe: () => ({ hasToken: false, source: "none" }),
};

/** A home with a runtime already chosen, so runtime is not the blocking step. */
function homeWithRuntime(): string {
  const home = tmp("jam-home-");
  mkdirSync(join(home, ".jam"), { recursive: true });
  writeFileSync(join(home, ".jam", "config.yaml"), "version: 1\nruntime:\n  mode: package\n", "utf8");
  return home;
}

function detect(root: string, home: string, credentials: CredentialPort) {
  // No remote in a temp directory, and asking the real git for one would make
  // every case here depend on the checkout the suite happens to run in.
  return detectSetupState({ cwd: root, home, credentials, git: () => undefined });
}

/**
 * This suite is about team adoption - the scope that writes into the
 * repository - so `--shared` is implied throughout. Personal scope, which is
 * the default, has its own describe below.
 */
function computeSetupPlan(
  state: Parameters<typeof computeScopedPlan>[0],
  options: PlanOptions = {},
): SetupPlan {
  return computeScopedPlan(state, { shared: true, ...options });
}

function computeSetupPlanWithPreflight(
  state: Parameters<typeof computeSharedPlanWithPreflight>[0],
  options: PlanOptions = {},
  run?: Parameters<typeof computeSharedPlanWithPreflight>[2],
): SetupPlan {
  return computeSharedPlanWithPreflight(state, { shared: true, ...options }, run);
}

/** A .mcp.json whose jam entry only works on the machine that wrote it. */
function withLegacyJamEntry(root: string): void {
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { jam: { command: "node", args: ["/abs/path"] } } }),
    "utf8",
  );
}

const targetAvailable: MigrationTarget = { spec: LAUNCHER_PACKAGE_SPEC, available: true };
const targetMissing: MigrationTarget = {
  spec: LAUNCHER_PACKAGE_SPEC,
  available: false,
  reason: "not-found",
  detail: "npm could not find it.",
};

/** A probe that fails the test if the preflight reaches for the network at all. */
function neverProbe(): MigrationTarget {
  throw new Error("migration target was probed when no replacement was pending");
}

describe("personal scope (the default)", () => {
  it("plans a binding and proposes nothing inside the repository", () => {
    const root = bareProject();
    const before = snapshot(root);

    const plan = computeScopedPlan(detect(root, homeWithRuntime(), configuredCredentials), {
      explicitKey: "PROJECT",
    });

    expect(plan.changes.map((c) => `${c.type}:${c.target}`)).toEqual(["create:personal-binding"]);
    expect(snapshot(root)).toEqual(before);
  });

  it("writes the binding to the user's home and leaves the repository byte-identical", () => {
    const root = bareProject();
    const home = homeWithRuntime();
    const before = snapshot(root);

    const plan = computeScopedPlan(detect(root, home, configuredCredentials), {
      explicitKey: "PROJECT",
    });
    applySetupPlan(plan, { home });

    expect(snapshot(root)).toEqual(before);
    expect(readdirSync(root)).toEqual([".git"]);
    expect(readFileSync(join(home, ".jam", "projects.yaml"), "utf8")).toContain("key: PROJECT");
  });

  it("plans nothing on a second pass", () => {
    const root = bareProject();
    const home = homeWithRuntime();
    applySetupPlan(
      computeScopedPlan(detect(root, home, configuredCredentials), { explicitKey: "PROJECT" }),
      { home },
    );

    const second = computeScopedPlan(detect(root, home, configuredCredentials), {
      explicitKey: "PROJECT",
    });

    expect(second.status).toBe("already_configured");
    expect(second.changes).toEqual([]);
  });

  it("re-binds explicitly, showing what is being replaced", () => {
    const root = bareProject();
    const home = homeWithRuntime();
    applySetupPlan(
      computeScopedPlan(detect(root, home, configuredCredentials), { explicitKey: "OLD" }),
      { home },
    );

    const plan = computeScopedPlan(detect(root, home, configuredCredentials), {
      explicitKey: "NEW",
    });

    // Not silent: the preview names the key that is about to be replaced.
    expect(plan.changes).toMatchObject([
      { type: "replace", target: "personal-binding", key: "NEW", previousKey: "OLD" },
    ]);
  });

  it("records nothing when the repository already declares its own key", () => {
    const root = bareProject();
    withProjectConfig(root, "TEAMKEY");

    const plan = computeScopedPlan(detect(root, homeWithRuntime(), configuredCredentials));

    // The team's file is already the answer; a second copy would only be
    // something to disagree with later.
    expect(plan.changes).toEqual([]);
    expect(plan.project?.key).toBe("TEAMKEY");
  });

  it("refuses to rewrite a binding file it could not read", () => {
    const root = bareProject();
    const home = homeWithRuntime();
    const bindings = join(home, ".jam", "projects.yaml");
    writeFileSync(bindings, "version: 1\nbindings: [ broken: : :\n", "utf8");
    const before = readFileSync(bindings, "utf8");

    const plan = computeScopedPlan(detect(root, home, configuredCredentials), {
      explicitKey: "PROJECT",
    });

    expect(plan.code).toBe("JAM_BINDINGS_UNREADABLE");
    expect(plan.changes).toEqual([]);
    expect(readFileSync(bindings, "utf8")).toBe(before);
  });

  it("ignores an unreadable .mcp.json, which personal setup never opens", () => {
    const root = bareProject();
    writeFileSync(join(root, ".mcp.json"), "{ not json", "utf8");

    const plan = computeScopedPlan(detect(root, homeWithRuntime(), configuredCredentials), {
      explicitKey: "PROJECT",
    });

    expect(plan.code).toBeUndefined();
    expect(plan.changes.map((c) => c.target)).toEqual(["personal-binding"]);
  });
});

describe("detectSetupState", () => {
  it("reads state without creating anything", () => {
    const root = bareProject();
    const home = homeWithRuntime();
    const before = snapshot(root);

    const state = detect(root, home, configuredCredentials);

    expect(snapshot(root)).toEqual(before);
    expect(state.project.hasConfig).toBe(false);
    expect(state.runtime).toMatchObject({ configured: true, mode: "package" });
    expect(state.credentials).toMatchObject({ present: true, source: "process" });
  });

  it("never carries the token into the snapshot", () => {
    const state = detect(bareProject(), homeWithRuntime(), configuredCredentials);
    expect(JSON.stringify(state)).not.toContain("SECRET");
  });
});

describe("computeSetupPlan", () => {
  it("plans both files for a fresh project and mutates nothing", () => {
    const root = bareProject();
    const home = homeWithRuntime();
    const before = snapshot(root);

    const plan = computeSetupPlan(detect(root, home, configuredCredentials), {
      explicitKey: "PROJECT",
    });

    expect(snapshot(root)).toEqual(before);
    expect(plan.status).toBe("ready_to_apply");
    expect(plan.changes.map((c) => `${c.type}:${c.target}`)).toEqual([
      "create:project-config",
      "create:mcp-config",
    ]);
  });

  it("requires a selection rather than guessing a key from the directory name", () => {
    const root = bareProject();
    const plan = computeSetupPlan(detect(root, homeWithRuntime(), configuredCredentials), {
      env: {},
      presetsPath: join(root, "no-presets.yaml"),
    });

    expect(plan.status).toBe("user_action_required");
    expect(plan.code).toBe("JAM_PROJECT_SELECTION_REQUIRED");
    expect(plan.changes).toEqual([]);
  });

  it("keeps an existing project key over an explicit override", () => {
    const root = bareProject();
    withProjectConfig(root, "EXISTING");

    const plan = computeSetupPlan(detect(root, homeWithRuntime(), configuredCredentials), {
      explicitKey: "OTHER",
    });

    expect(plan.project?.key).toBe("EXISTING");
    expect(plan.changes.some((c) => c.target === "project-config")).toBe(false);
  });

  it("plans a merge that names the servers it must preserve", () => {
    const root = bareProject();
    withProjectConfig(root, "PROJECT");
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "other-tool" } } }),
      "utf8",
    );

    const plan = computeSetupPlan(detect(root, homeWithRuntime(), configuredCredentials));
    const change = plan.changes.find((c) => c.target === "mcp-config");

    expect(change).toMatchObject({ type: "merge", preserveExisting: ["other"] });
  });

  it("leaves an existing jam entry alone unless migration is requested", () => {
    const root = bareProject();
    withProjectConfig(root, "PROJECT");
    withLegacyJamEntry(root);

    const state = detect(root, homeWithRuntime(), configuredCredentials);
    expect(computeSetupPlan(state).changes).toEqual([]);
    expect(
      computeSetupPlan(state, {
        migrate: true,
        jamEntryIsLegacy: true,
        migrationTarget: targetAvailable,
      }).changes,
    ).toMatchObject([{ type: "replace", reason: "migrate" }]);
  });

  it("still plans project wiring when credentials are missing, and flags the human step", () => {
    const root = bareProject();
    const plan = computeSetupPlan(detect(root, homeWithRuntime(), missingCredentials), {
      explicitKey: "PROJECT",
    });

    expect(plan.code).toBe("JAM_AUTH_REQUIRED");
    expect(plan.requiresUserAction).toBe(true);
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(plan.nextAction).toEqual({
      type: "authenticate",
      userCommand: `npx --yes @jam-mcp/bootstrap@${SERVER_VERSION} auth login`,
      env: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
    });
  });

  it("refuses a migration when the target cannot be found, and keeps the rest of the plan", () => {
    const root = bareProject();
    withLegacyJamEntry(root);

    const plan = computeSetupPlan(detect(root, homeWithRuntime(), configuredCredentials), {
      explicitKey: "PROJECT",
      migrate: true,
      jamEntryIsLegacy: true,
      migrationTarget: targetMissing,
    });

    expect(plan.code).toBe("JAM_MIGRATION_TARGET_UNAVAILABLE");
    expect(plan.requiresUserAction).toBe(true);
    expect(plan.migrationTarget).toEqual(targetMissing);
    // The rewrite is dropped; wiring the project is not the thing that failed.
    expect(plan.changes.some((c) => c.target === "mcp-config")).toBe(false);
    expect(plan.changes).toMatchObject([{ type: "create", target: "project-config" }]);
  });

  it("refuses a migration when nobody verified the target at all", () => {
    const root = bareProject();
    withProjectConfig(root, "PROJECT");
    withLegacyJamEntry(root);

    // No migrationTarget: a caller that forgets to check must not get a rewrite.
    const plan = computeSetupPlan(detect(root, homeWithRuntime(), configuredCredentials), {
      migrate: true,
      jamEntryIsLegacy: true,
    });

    expect(plan.code).toBe("JAM_MIGRATION_TARGET_UNAVAILABLE");
    expect(plan.changes).toEqual([]);
  });

  it("refuses a migration whose target is missing, without touching .mcp.json", () => {
    const root = bareProject();
    withLegacyJamEntry(root);
    const before = snapshot(root);

    const plan = computeSetupPlan(detect(root, homeWithRuntime(), configuredCredentials), {
      explicitKey: "PROJECT",
      migrate: true,
      jamEntryIsLegacy: true,
      migrationTarget: targetMissing,
    });
    applySetupPlan(plan);

    const after = snapshot(root);
    // The safe half of the plan really was applied...
    expect(existsSync(join(root, ".jira-agent", "project.yaml"))).toBe(true);
    // ...and the file the migration would have rewritten is byte-identical.
    expect(after[".mcp.json"]).toBe(before[".mcp.json"]);
  });

  it("refuses to touch an unparseable .mcp.json", () => {
    const root = bareProject();
    withProjectConfig(root, "PROJECT");
    writeFileSync(join(root, ".mcp.json"), "{ not json", "utf8");

    const plan = computeSetupPlan(detect(root, homeWithRuntime(), configuredCredentials));

    expect(plan.code).toBe("JAM_MCP_CONFIG_UNREADABLE");
    expect(plan.changes).toEqual([]);
  });
});

describe("applySetupPlan", () => {
  it("executes exactly what was planned, then plans nothing on a second pass", () => {
    const root = bareProject();
    const home = homeWithRuntime();

    const plan = computeSetupPlan(detect(root, home, configuredCredentials), {
      explicitKey: "PROJECT",
    });
    const result = applySetupPlan(plan);

    expect(result.changesApplied).toBe(true);
    expect(result.applied).toHaveLength(plan.changes.length);
    expect(existsSync(join(root, ".jira-agent", "project.yaml"))).toBe(true);
    expect(existsSync(join(root, ".mcp.json"))).toBe(true);

    // Idempotence: re-detecting after apply leaves nothing to do.
    const second = computeSetupPlan(detect(root, home, configuredCredentials));
    expect(second.changes).toEqual([]);
    expect(second.status).toBe("already_configured");

    const before = snapshot(root);
    expect(applySetupPlan(second).changesApplied).toBe(false);
    expect(snapshot(root)).toEqual(before);
  });

  it("preserves unrelated MCP servers when adding the jam entry", () => {
    const root = bareProject();
    withProjectConfig(root, "PROJECT");
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { atlassian: { command: "npx", args: ["mcp-remote"] } } }),
      "utf8",
    );

    const plan = computeSetupPlan(detect(root, homeWithRuntime(), configuredCredentials));
    applySetupPlan(plan);

    const written = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(written.mcpServers.atlassian).toEqual({ command: "npx", args: ["mcp-remote"] });
    expect(written.mcpServers.jam).toBeDefined();
  });

  it("applies nothing when the plan carries no changes", () => {
    const root = bareProject();
    const before = snapshot(root);

    applySetupPlan({ status: "already_configured", changes: [], requiresUserAction: false });

    expect(snapshot(root)).toEqual(before);
  });

  it("writes no credential material into the project", () => {
    const root = bareProject();
    const plan = computeSetupPlan(detect(root, homeWithRuntime(), configuredCredentials), {
      explicitKey: "PROJECT",
    });
    applySetupPlan(plan);

    const written = JSON.stringify(snapshot(root));
    expect(written).not.toContain("SECRET");
    expect(written).not.toMatch(/JIRA_API_TOKEN\s*[":]/);
  });
});

describe("computeSetupPlanWithPreflight", () => {
  const nonCandidates: [string, (root: string) => void][] = [
    ["there is no .mcp.json to replace", () => {}],
    [
      "the .mcp.json has no jam entry",
      (root) => writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: {} }), "utf8"),
    ],
    [
      "the jam entry is already canonical",
      (root) =>
        writeFileSync(
          join(root, ".mcp.json"),
          JSON.stringify({
            mcpServers: { jam: { command: "npx", args: ["--yes", LAUNCHER_PACKAGE_SPEC, "serve"] } },
          }),
          "utf8",
        ),
    ],
  ];

  for (const [why, arrange] of nonCandidates) {
    it(`does not probe the registry when ${why}`, () => {
      const root = bareProject();
      withProjectConfig(root, "PROJECT");
      arrange(root);

      const plan = computeSetupPlanWithPreflight(
        detect(root, homeWithRuntime(), configuredCredentials),
        { migrate: true, env: {} },
        neverProbe,
      );

      expect(plan.code).not.toBe("JAM_MIGRATION_TARGET_UNAVAILABLE");
    });
  }

  it("does not probe the registry when the plan stops before wiring", () => {
    const root = bareProject();
    withLegacyJamEntry(root);

    const plan = computeSetupPlanWithPreflight(
      detect(root, homeWithRuntime(), configuredCredentials),
      { migrate: true, env: {} },
      neverProbe,
    );

    expect(plan.code).toBe("JAM_PROJECT_SELECTION_REQUIRED");
  });

  it("probes once when a replacement is pending, and plans it when the target is there", () => {
    const root = bareProject();
    withProjectConfig(root, "PROJECT");
    withLegacyJamEntry(root);

    let probes = 0;
    const plan = computeSetupPlanWithPreflight(
      detect(root, homeWithRuntime(), configuredCredentials),
      { migrate: true, env: {} },
      () => {
        probes += 1;
        return targetAvailable;
      },
    );

    expect(probes).toBe(1);
    expect(plan.changes).toMatchObject([{ type: "replace", reason: "migrate" }]);
  });

  it("prefers an injected target over probing", () => {
    const root = bareProject();
    withProjectConfig(root, "PROJECT");
    withLegacyJamEntry(root);

    const plan = computeSetupPlanWithPreflight(
      detect(root, homeWithRuntime(), configuredCredentials),
      { migrate: true, env: {}, migrationTarget: targetMissing },
      neverProbe,
    );

    expect(plan.code).toBe("JAM_MIGRATION_TARGET_UNAVAILABLE");
  });
});

describe("checkMigrationTarget", () => {
  const run = (result: Partial<RunResult>) => () => ({ status: 1, stderr: "", ...result });

  it("accepts a spec npm can resolve", () => {
    expect(checkMigrationTarget("pkg@1.0.0", run({ status: 0 }))).toEqual({
      spec: "pkg@1.0.0",
      available: true,
    });
  });

  it("reports a spec the registry does not have as not-found", () => {
    const target = checkMigrationTarget("pkg@1.0.0", run({ stderr: "npm error code E404\n" }));

    expect(target).toMatchObject({ available: false, reason: "not-found" });
  });

  it("treats a timeout as unverified rather than missing", () => {
    const error = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const target = checkMigrationTarget("pkg@1.0.0", run({ status: null, error }));

    expect(target).toMatchObject({ available: false, reason: "unverifiable" });
    expect(target.detail).toContain("ETIMEDOUT");
  });

  it("treats a missing npm as unverified rather than missing", () => {
    const error = Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
    const target = checkMigrationTarget("pkg@1.0.0", run({ status: null, error }));

    expect(target).toMatchObject({ available: false, reason: "unverifiable" });
  });

  it("treats an unreachable registry as unverified rather than missing", () => {
    const target = checkMigrationTarget("pkg@1.0.0", run({ stderr: "npm error code ENOTFOUND\n" }));

    expect(target).toMatchObject({ available: false, reason: "unverifiable" });
  });
});

/**
 * What a plan tells a machine to run next.
 *
 * A plan is read by agents on machines that have just met JAM. `jam` is an
 * optional convenience there, not a given, and the launcher cannot help either
 * until a runtime is configured - so every executable command a plan emits has
 * to go through bootstrap. This is easy to regress: on a maintainer's laptop
 * `jam setup --project X` works perfectly.
 */
describe("nextAction is executable on a machine with nothing installed", () => {
  function homeWithoutRuntime(): string {
    const home = tmp("jam-home-");
    mkdirSync(join(home, ".jam"), { recursive: true });
    return home;
  }

  it("names bootstrap, not a bare `jam`, when a project must be chosen", () => {
    const plan = computeSetupPlan(detect(bareProject(), homeWithRuntime(), configuredCredentials));

    expect(plan.code).toBe("JAM_PROJECT_SELECTION_REQUIRED");
    expect(plan.nextAction?.command).toBe(
      `npx --yes @jam-mcp/bootstrap@${SERVER_VERSION} setup --project <KEY>`,
    );
  });

  it("names bootstrap when the runtime itself is what is missing", () => {
    const root = bareProject();
    const plan = computeSetupPlan(detect(root, homeWithoutRuntime(), configuredCredentials), {
      explicitKey: "PROJECT",
    });

    expect(plan.code).toBe("JAM_RUNTIME_CONFIG_MISSING");
    expect(plan.nextAction?.command).toBe(
      `npx --yes @jam-mcp/bootstrap@${SERVER_VERSION} runtime use package`,
    );
  });

  it("offers no runnable command at all for the one step a person must take themselves", () => {
    const plan = computeSetupPlan(detect(bareProject(), homeWithRuntime(), missingCredentials), {
      explicitKey: "PROJECT",
    });

    // `jam auth login` is interactive by design; handing an agent a `command`
    // here would invite it to run one on someone's behalf. What it gets is a
    // `userCommand` to relay, and the variable names that would do instead -
    // enough to ask the person for the right thing, never enough to act.
    expect(plan.nextAction?.type).toBe("authenticate");
    expect(plan.nextAction?.command).toBeUndefined();
    expect(plan.nextAction?.userCommand).toBe(
      `npx --yes @jam-mcp/bootstrap@${SERVER_VERSION} auth login`,
    );
    expect(plan.nextAction?.env).toEqual(["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]);
  });

  it("emits no bare `jam` command from any plan", () => {
    const plans = [
      computeSetupPlan(detect(bareProject(), homeWithRuntime(), configuredCredentials)),
      computeSetupPlan(detect(bareProject(), homeWithoutRuntime(), configuredCredentials), {
        explicitKey: "PROJECT",
      }),
      computeSetupPlan(detect(bareProject(), homeWithRuntime(), missingCredentials), {
        explicitKey: "PROJECT",
      }),
    ];

    for (const plan of plans) {
      // Both fields end up in front of a machine with no PATH to rely on: one
      // is run, the other is shown and then typed. A bare `jam` fails either
      // way.
      for (const command of [plan.nextAction?.command, plan.nextAction?.userCommand]) {
        if (command === undefined) continue;
        expect(command.startsWith("jam ")).toBe(false);
        expect(command).toMatch(/^npx --yes @jam-mcp\/\S+@\d+\.\d+\.\d+ /);
      }
    }
  });
});
