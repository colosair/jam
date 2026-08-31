import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../support/temp.js";
import { describe, expect, it } from "vitest";
import { decideProjectKey, writeBootstrapConfig } from "../../src/bootstrap/project-config-bootstrapper.js";
import { resolveProjectConfig } from "../../src/bootstrap/project-config-resolver.js";
import { resolveProjectRoot } from "../../src/bootstrap/project-root-resolver.js";
import {
  mergeMcpConfig,
  isLegacyJamEntry,
  JAM_MCP_ENTRY,
} from "../../src/bootstrap/mcp-config-merger.js";

function tmp(prefix: string): string {
  return tempDir(prefix);
}

function withConfig(root: string, yaml: string): void {
  mkdirSync(join(root, ".jira-agent"), { recursive: true });
  writeFileSync(join(root, ".jira-agent", "project.yaml"), yaml, "utf8");
}

describe("resolveProjectRoot", () => {
  it("finds the nearest .jira-agent directory from a nested cwd", () => {
    const root = tmp("jam-root-");
    withConfig(root, "version: 1\nproject:\n  key: PROJECT\n");
    const nested = join(root, "src", "deep");
    mkdirSync(nested, { recursive: true });

    expect(resolveProjectRoot(nested)).toEqual({ root, hasConfig: true });
  });

  it("falls back to the nearest .git directory when there is no config", () => {
    const root = tmp("jam-git-dir-");
    mkdirSync(join(root, ".git"), { recursive: true });
    const nested = join(root, "apps", "web");
    mkdirSync(nested, { recursive: true });

    // gitRoot is reported alongside: the walk already found it, and workspace
    // identity needs it rather than repeating the search.
    expect(resolveProjectRoot(nested)).toEqual({ root, hasConfig: false, gitRoot: root });
  });

  it("treats a .git FILE (worktree/submodule) the same as a .git directory", () => {
    const root = tmp("jam-git-file-");
    writeFileSync(join(root, ".git"), "gitdir: ../.git/worktrees/feature\n", "utf8");
    const nested = join(root, "src");
    mkdirSync(nested, { recursive: true });

    expect(resolveProjectRoot(nested)).toEqual({ root, hasConfig: false, gitRoot: root });
  });

  it("uses the nearest ancestor, not the outermost repo root", () => {
    const outer = tmp("jam-outer-");
    mkdirSync(join(outer, ".git"), { recursive: true });
    const inner = join(outer, "packages", "app");
    mkdirSync(join(inner, ".git"), { recursive: true });

    expect(resolveProjectRoot(inner).root).toBe(inner);
  });
});

describe("decideProjectKey", () => {
  it("prefers an explicit key over everything else", () => {
    const root = tmp("jam-explicit-");
    expect(decideProjectKey(root, { explicitKey: "PROJECT" })).toEqual({
      key: "PROJECT",
      source: "explicit",
    });
  });

  it("falls back to JAM_PROJECT_KEY when no explicit key is given", () => {
    const root = tmp("jam-env-");
    expect(decideProjectKey(root, { env: { JAM_PROJECT_KEY: "PROJECT" } })).toEqual({
      key: "PROJECT",
      source: "env",
    });
  });

  it("falls back to a preset match by absolute path", () => {
    const root = tmp("jam-preset-");
    const presetsPath = join(root, "presets.yaml");
    // Single-quoted YAML scalars need no backslash escaping, which sidesteps
    // Windows path backslashes entirely.
    writeFileSync(presetsPath, `projects:\n  - match: '${root}'\n    key: PROJECT\n`, "utf8");

    expect(decideProjectKey(root, { env: {}, presetsPath })).toEqual({
      key: "PROJECT",
      source: "preset",
    });
  });

  it.skipIf(process.platform !== "win32")("matches presets case-insensitively on Windows", () => {
    const root = tmp("jam-preset-case-");
    const presetsPath = join(root, "presets.yaml");
    const shouted = root.toUpperCase();
    writeFileSync(presetsPath, `projects:\n  - match: '${shouted}'\n    key: PROJECT\n`, "utf8");

    expect(decideProjectKey(root, { env: {}, presetsPath })?.key).toBe("PROJECT");
  });

  it("returns undefined - never guesses - when no source applies", () => {
    const root = tmp("jam-none-");
    expect(decideProjectKey(root, { env: {}, presetsPath: join(root, "does-not-exist.yaml") })).toBeUndefined();
  });
});

describe("resolveProjectConfig", () => {
  it("uses an existing config as-is and does not touch the file", () => {
    const root = tmp("jam-existing-");
    withConfig(root, "version: 1\nproject:\n  key: PROJECT\n");

    const resolved = resolveProjectConfig({
      cwd: root,
      keyFallback: "required",
      explicitKey: "SHOULD_BE_IGNORED",
    });
    expect(resolved.config.project.key).toBe("PROJECT");
    expect(resolved.configPath).toBeTruthy();
    // The file said it, so there is no fallback source to report.
    expect(resolved.keySource).toBeUndefined();
  });

  it("resolves a decided key in memory and writes nothing", () => {
    const root = tmp("jam-fallback-");
    mkdirSync(join(root, ".git"), { recursive: true });

    const resolved = resolveProjectConfig({
      cwd: root,
      keyFallback: "required",
      explicitKey: "PROJECT",
      env: {},
      presetsPath: join(root, "does-not-exist.yaml"),
    });

    expect(resolved.config.project.key).toBe("PROJECT");
    expect(resolved.keySource).toBe("explicit");
    expect(resolved.configPath).toBeUndefined();
    // Deciding a key is resolution; persisting one is `jam setup`'s job alone.
    expect(existsSync(join(root, ".jira-agent"))).toBe(false);
  });

  it("throws JAM_SETUP_REQUIRED and writes nothing when no key can be decided safely", () => {
    const root = tmp("jam-undecided-");
    mkdirSync(join(root, ".git"), { recursive: true });

    // env is pinned: an ambient JAM_PROJECT_KEY would otherwise supply a key
    // and this test would stop testing the "no safe source" path.
    expect(() =>
      resolveProjectConfig({
        cwd: root,
        keyFallback: "required",
        env: {},
        presetsPath: join(root, "does-not-exist.yaml"),
      }),
    ).toThrowError(expect.objectContaining({ code: "JAM_SETUP_REQUIRED" }));
    expect(existsSync(join(root, ".jira-agent", "project.yaml"))).toBe(false);
  });

  it("resolves a binding-supplied key without throwing, for the read-only commands", () => {
    const root = tmp("jam-optional-");
    mkdirSync(join(root, ".git"), { recursive: true });

    // "optional" is what doctor passes: report what serve would run with, and
    // never refuse to load just because nothing supplied a key.
    const resolved = resolveProjectConfig({
      cwd: root,
      keyFallback: "optional",
      env: {},
      presetsPath: join(root, "does-not-exist.yaml"),
    });

    expect(resolved.config.project.key).toBe("");
    expect(resolved.keySource).toBeUndefined();

    const withKey = resolveProjectConfig({
      cwd: root,
      keyFallback: "optional",
      explicitKey: "PROJECT",
      env: {},
      presetsPath: join(root, "does-not-exist.yaml"),
    });

    expect(withKey.config.project.key).toBe("PROJECT");
    expect(existsSync(join(root, ".jira-agent"))).toBe(false);
  });

  it("falls back to defaults when no fallback key is allowed (doctor's read-only path)", () => {
    const root = tmp("jam-readonly-");
    mkdirSync(join(root, ".git"), { recursive: true });

    const resolved = resolveProjectConfig({ cwd: root });
    expect(resolved.config.project.key).toBe("");
    expect(resolved.keySource).toBeUndefined();
    expect(existsSync(join(root, ".jira-agent", "project.yaml"))).toBe(false);
  });
});

describe("mergeMcpConfig", () => {
  it("creates a PATH-based entry when there is no .mcp.json yet", () => {
    const root = tmp("jam-mcp-new-");
    const result = mergeMcpConfig(root);

    expect(result.action).toBe("created");
    const written = JSON.parse(readFile(result.path));
    expect(written.mcpServers.jam).toEqual(JAM_MCP_ENTRY);
  });

  it("adds a jam entry without touching existing MCP servers", () => {
    const root = tmp("jam-mcp-preserve-");
    const path = join(root, ".mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "other-tool" } } }), "utf8");

    const result = mergeMcpConfig(root);
    expect(result.action).toBe("added");
    const written = JSON.parse(readFile(path));
    expect(written.mcpServers.other).toEqual({ command: "other-tool" });
    expect(written.mcpServers.jam).toEqual(JAM_MCP_ENTRY);
  });

  it("leaves an existing jam entry untouched", () => {
    const root = tmp("jam-mcp-unchanged-");
    const path = join(root, ".mcp.json");
    const custom = { mcpServers: { jam: { command: "jam", args: ["serve", "--verbose"] } } };
    writeFileSync(path, JSON.stringify(custom), "utf8");

    const result = mergeMcpConfig(root);
    expect(result.action).toBe("unchanged");
    expect(JSON.parse(readFile(path))).toEqual(custom);
  });

  it("never records a machine-specific absolute path", () => {
    const root = tmp("jam-mcp-team-safe-");
    const result = mergeMcpConfig(root);
    const raw = readFile(result.path);

    expect(raw).not.toContain(root);
    // Goes through the launcher, so the file says "this project uses JAM"
    // without naming any particular install on any particular machine.
    expect(JSON.parse(raw).mcpServers.jam).toEqual(JAM_MCP_ENTRY);
  });

  it("pins the launcher to an exact version rather than a floating tag", () => {
    const spec = JAM_MCP_ENTRY.args.find((a) => a.startsWith("@jam-mcp/launcher@"));

    expect(spec).toBeDefined();
    expect(spec).toMatch(/@\d+\.\d+\.\d+$/);
    expect(JSON.stringify(JAM_MCP_ENTRY)).not.toContain("latest");
  });
});

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

describe("legacy jam entries", () => {
  it("recognises wiring that only works on the machine that wrote it", () => {
    // A hard-coded checkout path.
    expect(isLegacyJamEntry({ command: "node", args: ["/abs/path/index.js", "serve"] })).toBe(true);
    expect(isLegacyJamEntry({ command: "npx", args: ["--yes", "something-else", "serve"] })).toBe(true);
  });

  it("respects a bare `jam` — the persistent install someone chose", () => {
    // On a machine whose package runner is broken, `jam serve` is the entry
    // that still works. Rewriting it back to npx would reinstate the failure.
    expect(isLegacyJamEntry({ command: "jam", args: ["serve"] })).toBe(false);
  });

  it("does not treat current launcher-based wiring as legacy", () => {
    expect(isLegacyJamEntry(JAM_MCP_ENTRY)).toBe(false);
  });

  it("ignores anything that is not an entry object", () => {
    expect(isLegacyJamEntry(undefined)).toBe(false);
    expect(isLegacyJamEntry("jam")).toBe(false);
  });
});
