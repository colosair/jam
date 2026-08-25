import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { applySetupPlan } from "../../src/bootstrap/setup-apply.js";
import { computeSetupPlan } from "../../src/bootstrap/setup-plan.js";
import { detectSetupState } from "../../src/bootstrap/setup-state.js";
import type { CredentialPort } from "../../src/ports/credentials.port.js";

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

/** Recursive snapshot of a directory tree: relative path -> contents. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[relative(root, full)] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}

function detect(root: string, home: string, credentials: CredentialPort) {
  return detectSetupState({ cwd: root, home, credentials });
}

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
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { jam: { command: "node", args: ["/abs/path"] } } }),
      "utf8",
    );

    const state = detect(root, homeWithRuntime(), configuredCredentials);
    expect(computeSetupPlan(state).changes).toEqual([]);
    expect(
      computeSetupPlan(state, { migrate: true, jamEntryIsLegacy: true }).changes,
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
    expect(plan.nextAction).toEqual({ type: "authenticate" });
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
