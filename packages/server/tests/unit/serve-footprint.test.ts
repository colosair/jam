import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../support/temp.js";
import { describe, expect, it } from "vitest";
import { bootstrapForServe } from "../../src/bootstrap/bootstrap-orchestrator.js";
import { writeProjectBinding } from "../../src/bootstrap/project-bindings.js";
import { serve } from "../../src/cli/serve.js";
import type { CredentialPort } from "../../src/ports/credentials.port.js";
import { FakeJira, snapshot } from "../helpers.js";

/**
 * Starting the MCP server is not a configuration command.
 *
 * `jam serve` used to create `.jira-agent/project.yaml` on the way past,
 * whenever a key could be decided - so merely opening an editor left a file in
 * someone's repository. These tests hold the working tree byte-identical
 * across the boot path, including the two cases that used to write.
 */

const noCredentials: CredentialPort = {
  load: () => {
    throw new Error("no credentials");
  },
  describe: () => ({ hasToken: false, source: "none" }),
};

function tmp(prefix: string): string {
  return tempDir(prefix);
}

/** A repo with no JAM wiring at all. */
function bareRepo(): string {
  const root = tmp("jam-serve-");
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# example\n", "utf8");
  return root;
}

/**
 * The credentials are missing on purpose: the boot gate then fails and `serve`
 * returns before `connect()`, so no test ever takes over stdio. The write
 * under test happens earlier than the gate, in `buildDeps`.
 */
async function runServe(
  root: string,
  extra: {
    env?: NodeJS.ProcessEnv;
    presetsPath?: string;
    home?: string;
    git?: () => string | undefined;
  } = {},
): Promise<number> {
  return serve({
    cwd: root,
    jira: new FakeJira({}),
    credentials: noCredentials,
    env: {},
    ...extra,
  });
}

describe("jam serve leaves the repository alone", () => {
  it("refuses to start rather than guessing a key, and writes nothing", async () => {
    const root = bareRepo();
    const before = snapshot(root);

    await expect(
      runServe(root, { presetsPath: join(tmp("jam-nopresets-"), "presets.yaml") }),
    ).rejects.toMatchObject({ code: "JAM_SETUP_REQUIRED" });

    expect(snapshot(root)).toEqual(before);
  });

  it("resolves JAM_PROJECT_KEY without creating project.yaml", async () => {
    const root = bareRepo();
    const before = snapshot(root);

    const code = await runServe(root, {
      env: { JAM_PROJECT_KEY: "PROJECT" },
      presetsPath: join(tmp("jam-nopresets-"), "presets.yaml"),
    });

    expect(code).toBe(1);
    expect(snapshot(root)).toEqual(before);
    // snapshot() records files, so an empty directory left behind by a
    // half-write would otherwise pass unnoticed.
    expect(existsSync(join(root, ".jira-agent"))).toBe(false);
  });

  it("resolves a matching preset without creating project.yaml", async () => {
    const root = bareRepo();
    // The presets file lives outside the repo, so writing it cannot perturb
    // the snapshot being compared.
    const presetsPath = join(tmp("jam-presets-"), "presets.yaml");
    writeFileSync(presetsPath, `projects:\n  - match: ${JSON.stringify(root)}\n    key: PRESETKEY\n`, "utf8");
    const before = snapshot(root);

    const code = await runServe(root, { presetsPath });

    expect(code).toBe(1);
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(root, ".jira-agent"))).toBe(false);
  });

  it("resolves a personal binding without writing to the repo or to ~/.jam", async () => {
    const root = bareRepo();
    const home = tmp("jam-bindhome-");
    writeProjectBinding({ workspace: "git:github.com/acme/web", key: "BOUND" }, home);

    const beforeRepo = snapshot(root);
    const beforeHome = snapshot(home);

    const { deps } = await bootstrapForServe({
      cwd: root,
      jira: new FakeJira({}),
      credentials: noCredentials,
      env: {},
      presetsPath: join(tmp("jam-nopresets-"), "presets.yaml"),
      home,
      git: () => "git@github.com:acme/web.git",
    });

    expect(deps.config.project.key).toBe("BOUND");
    expect(deps.keySource).toBe("binding");
    expect(deps.configPath).toBeUndefined();
    expect(snapshot(root)).toEqual(beforeRepo);
    // The binding store is the user's, not serve's to maintain.
    expect(snapshot(home)).toEqual(beforeHome);
  });

  it("reads an existing config and never rewrites it", async () => {
    const root = bareRepo();
    mkdirSync(join(root, ".jira-agent"), { recursive: true });
    // Deliberately non-canonical: a silent rewrite would normalise this, so a
    // regression shows up as changed content rather than only as a new file.
    const original = [
      "# hand written, kept as is",
      "project:",
      "  key: EXISTING",
      "version: 1",
      "",
      "",
    ].join("\n");
    writeFileSync(join(root, ".jira-agent", "project.yaml"), original, "utf8");
    const before = snapshot(root);

    const { deps } = await bootstrapForServe({
      cwd: root,
      jira: new FakeJira({}),
      credentials: noCredentials,
      env: { JAM_PROJECT_KEY: "OTHER" },
    });

    // The committed file wins over the ambient environment variable.
    expect(deps.config.project.key).toBe("EXISTING");
    expect(deps.configPath).toBeTruthy();
    expect(snapshot(root)).toEqual(before);
  });
});
