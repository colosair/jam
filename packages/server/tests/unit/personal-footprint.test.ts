import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bootstrapForServe } from "../../src/bootstrap/bootstrap-orchestrator.js";
import {
  doctorJsonCommand,
  setupAgentCommand,
  setupApplyCommand,
  setupPlanCommand,
} from "../../src/cli/agent-api.js";
import type { CredentialPort } from "../../src/ports/credentials.port.js";
import { FakeCredentials, FakeJira, snapshot } from "../helpers.js";

/**
 * The promise personal scope makes: you can use JAM in a repository you do
 * not own, and leave it exactly as you found it.
 *
 * This walks the whole lifecycle - plan, apply, the one-shot agent path,
 * an explicit rebind, serve, doctor - and compares the tree before and
 * after. `git status --porcelain` would show nothing because there is
 * nothing to show: not one file was created, changed or removed.
 */

const noHosts = () => ({ status: null, failed: true, stdout: '' });
const noCredentials: CredentialPort = {
  load: () => {
    throw new Error("no credentials");
  },
  describe: () => ({ hasToken: false, source: "none" }),
};

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function repo(): string {
  const root = tmp("jam-personal-");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export const answer = 42;\n", "utf8");
  writeFileSync(join(root, "README.md"), "# someone else's project\n", "utf8");
  return root;
}

function homeWithRuntime(): string {
  const home = tmp("jam-personalhome-");
  mkdirSync(join(home, ".jam"), { recursive: true });
  writeFileSync(join(home, ".jam", "config.yaml"), "version: 1\nruntime:\n  mode: package\n", "utf8");
  return home;
}

/** Swallows the JSON these commands emit; the assertions are about files. */
async function quiet<T>(run: () => Promise<T> | T): Promise<T> {
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

describe("personal scope leaves the repository untouched", () => {
  it("survives the whole lifecycle with a byte-identical working tree", async () => {
    const root = repo();
    const home = homeWithRuntime();
    const before = snapshot(root);

    const agentOptions = {
      cwd: root,
      home,
      credentials: new FakeCredentials(),
      env: {},
      git: () => "git@github.com:acme/web.git",
      runHost: noHosts,
    };

    await quiet(() => setupPlanCommand({ ...agentOptions, explicitKey: "PROJECT" }));
    await quiet(() => setupApplyCommand({ ...agentOptions, explicitKey: "PROJECT" }));
    await quiet(() => setupAgentCommand({ ...agentOptions, explicitKey: "PROJECT" }));
    // An explicit rebind, which rewrites the user's file and nothing else.
    await quiet(() => setupApplyCommand({ ...agentOptions, explicitKey: "OTHER" }));
    await quiet(() => doctorJsonCommand(agentOptions));

    await bootstrapForServe({
      cwd: root,
      home,
      jira: new FakeJira({}),
      credentials: noCredentials,
      env: {},
      git: () => "git@github.com:acme/web.git",
    });

    expect(snapshot(root)).toEqual(before);
    // Nothing new at the top level either - no .jira-agent, no .mcp.json.
    expect(readdirSync(root).sort()).toEqual([".git", "README.md", "src"]);
  });

  it("records the binding in the user's own home, where it belongs", async () => {
    const root = repo();
    const home = homeWithRuntime();

    await quiet(() =>
      setupApplyCommand({
        cwd: root,
        home,
        explicitKey: "PROJECT",
        credentials: new FakeCredentials(),
        env: {},
        git: () => "git@github.com:acme/web.git",
        runHost: noHosts,
      }),
    );

    const written = snapshot(home);
    expect(Object.keys(written)).toContain(join(".jam", "projects.yaml"));
    expect(written[join(".jam", "projects.yaml")]).toContain("git:github.com/acme/web");
    // The binding file is not a place for credentials, and never becomes one.
    expect(JSON.stringify(written)).not.toContain("SECRET");
  });

  it("still writes the repository files when the team scope is asked for", async () => {
    const root = repo();
    const home = homeWithRuntime();

    await quiet(() =>
      setupApplyCommand({
        cwd: root,
        home,
        shared: true,
        explicitKey: "PROJECT",
        credentials: new FakeCredentials(),
        env: {},
        git: () => "git@github.com:acme/web.git",
        runHost: noHosts,
      }),
    );

    // Protecting the personal path must not have cost the team path anything.
    expect(readdirSync(root).sort()).toEqual([".git", ".jira-agent", ".mcp.json", "README.md", "src"]);
  });
});
