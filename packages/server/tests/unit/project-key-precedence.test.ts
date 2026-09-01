// Project key precedence, and what happens when two sources disagree.
//
// The field case that prompted this: a machine carried a personal binding for
// an old key, the operator ran `setup --agent --project <NEW>`, and had to go
// delete ~/.jam/projects.yaml by hand before setup would proceed. What someone
// types for this run has to beat what was recorded some time ago - except
// against the repository's own project.yaml, which is the team's committed
// answer and is never overwritten silently.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeSetupPlan } from "../../src/bootstrap/setup-plan.js";
import { detectSetupState } from "../../src/bootstrap/setup-state.js";
import { tempDir } from "../support/temp.js";
import type { CredentialPort } from "../../src/ports/credentials.port.js";

const credentials: CredentialPort = {
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

const NEW_KEY = "S15P21A604";
const OLD_KEY = "OLDKEY";

function project(): string {
  const root = tempDir("jam-precedence-");
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

function homeWithRuntime(): string {
  const home = tempDir("jam-precedence-home-");
  mkdirSync(join(home, ".jam"), { recursive: true });
  writeFileSync(join(home, ".jam", "config.yaml"), "version: 1\nruntime:\n  mode: package\n", "utf8");
  return home;
}

function withBinding(home: string, workspace: string, key: string): void {
  writeFileSync(
    join(home, ".jam", "projects.yaml"),
    ["version: 1", "bindings:", `  - workspace: "${workspace}"`, `    key: ${key}`, ""].join("\n"),
    "utf8",
  );
}

function withRepositoryConfig(root: string, key: string): void {
  mkdirSync(join(root, ".jira-agent"), { recursive: true });
  writeFileSync(
    join(root, ".jira-agent", "project.yaml"),
    ["version: 1", "project:", `  key: ${key}`, ""].join("\n"),
    "utf8",
  );
}

function withPresets(home: string, root: string, key: string): string {
  const path = join(home, "presets.yaml");
  writeFileSync(path, ["projects:", `  - match: "${root}"`, `    key: ${key}`, ""].join("\n"), "utf8");
  return path;
}

/** Detect + plan with everything injected, so no test reads the real machine. */
function plan(options: {
  root: string;
  home: string;
  explicitKey?: string;
  env?: NodeJS.ProcessEnv;
  presetsPath?: string;
  git?: () => string | undefined;
}) {
  const state = detectSetupState({
    cwd: options.root,
    home: options.home,
    credentials,
    git: options.git ?? (() => "git@github.com:example/precedence.git"),
    probeHosts: false,
  });
  return {
    state,
    plan: computeSetupPlan(state, {
      ...(options.explicitKey ? { explicitKey: options.explicitKey } : {}),
      env: options.env ?? {},
      ...(options.presetsPath ? { presetsPath: options.presetsPath } : {}),
    }),
  };
}

describe("project key precedence - explicit beats every personal source", () => {
  it("--project wins over a stale personal binding, and rebinds instead of stopping", () => {
    const root = project();
    const home = homeWithRuntime();
    const first = plan({ root, home });
    withBinding(home, first.state.workspaceId, OLD_KEY);

    const { plan: result } = plan({ root, home, explicitKey: NEW_KEY });

    expect(result.code).toBeUndefined();
    expect(result.requiresUserAction).toBe(false);
    expect(result.project?.key).toBe(NEW_KEY);
    const binding = result.changes.find((c) => c.target === "personal-binding");
    expect(binding).toMatchObject({ type: "replace", key: NEW_KEY, previousKey: OLD_KEY });
  });

  it("--project wins over a stale JAM_PROJECT_KEY", () => {
    const root = project();
    const home = homeWithRuntime();
    const { plan: result } = plan({
      root,
      home,
      explicitKey: NEW_KEY,
      env: { JAM_PROJECT_KEY: OLD_KEY },
    });
    expect(result.project?.key).toBe(NEW_KEY);
    expect(result.requiresUserAction).toBe(false);
  });

  it("--project wins over a stale legacy preset", () => {
    const root = project();
    const home = homeWithRuntime();
    const presetsPath = withPresets(home, root, OLD_KEY);
    const { plan: result } = plan({ root, home, explicitKey: NEW_KEY, presetsPath });
    expect(result.project?.key).toBe(NEW_KEY);
    expect(result.requiresUserAction).toBe(false);
  });

  it("a repository project.yaml that agrees with --project is not a conflict", () => {
    const root = project();
    const home = homeWithRuntime();
    withRepositoryConfig(root, NEW_KEY);
    const { plan: result } = plan({ root, home, explicitKey: NEW_KEY });
    expect(result.code).toBeUndefined();
    expect(result.project?.key).toBe(NEW_KEY);
  });

  it("a repository project.yaml that disagrees stops with a machine-readable conflict", () => {
    const root = project();
    const home = homeWithRuntime();
    withRepositoryConfig(root, OLD_KEY);
    const { plan: result } = plan({ root, home, explicitKey: NEW_KEY });

    expect(result.code).toBe("JAM_PROJECT_KEY_CONFLICT");
    expect(result.requiresUserAction).toBe(true);
    expect(result.requested).toEqual({ key: NEW_KEY, source: "explicit" });
    expect(result.existing).toEqual({ key: OLD_KEY, source: "repository" });
    // The team's committed answer is never rewritten on our own initiative.
    expect(result.changes.some((c) => c.target === "project-config")).toBe(false);
  });

  it("a repository key with no --project is used as-is, and reported as repository", () => {
    const root = project();
    const home = homeWithRuntime();
    withRepositoryConfig(root, OLD_KEY);
    const { plan: result } = plan({ root, home });
    expect(result.code).toBeUndefined();
    expect(result.project?.key).toBe(OLD_KEY);
    expect(result.project?.keySource).toBe("repository");
  });
});
