import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupNow, tempDir } from "../../server/tests/support/temp.js";

afterAll(() => cleanupNow());
import { afterAll, describe, expect, it } from "vitest";
import {
  normalizeRuntimeConfig,
  readRuntimeConfig,
  runtimeConfigPath,
  writeRuntimeConfig,
} from "../src/runtime-config.js";
import { resolveRuntime, resolveConfiguredRuntime } from "../src/runtime-resolver.js";
import { resolveInstalledServer, resolvePackageRuntime } from "../src/package-runtime.js";
import { resolveDevelopmentRuntime, SERVER_ENTRY_RELATIVE } from "../src/development-runtime.js";
import { SERVER_PACKAGE_SPEC, SERVER_VERSION } from "../src/release.js";

function tmp(prefix: string): string {
  return tempDir(prefix);
}

/** Build a directory that passes every development-source check. */
function fakeCheckout(opts: { built?: boolean; name?: string; version?: string } = {}): string {
  const root = tmp("jam-src-");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "jam-monorepo" }), "utf8");
  const serverDir = join(root, "packages", "server");
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(
    join(serverDir, "package.json"),
    JSON.stringify({ name: opts.name ?? "@jam-mcp/server", version: opts.version ?? "1.0.0" }),
    "utf8",
  );
  if (opts.built !== false) {
    mkdirSync(join(serverDir, "dist"), { recursive: true });
    writeFileSync(join(serverDir, "dist", "index.js"), "// built\n", "utf8");
  }
  return root;
}

describe("runtime config", () => {
  it("round-trips package mode", () => {
    const home = tmp("jam-home-");
    const path = writeRuntimeConfig({ version: 1, runtime: { mode: "package" } }, home);

    expect(path).toBe(runtimeConfigPath(home));
    expect(readRuntimeConfig(home)).toEqual({ version: 1, runtime: { mode: "package" } });
  });

  it("round-trips development mode, including a Windows-style path", () => {
    const home = tmp("jam-home-");
    const source = "C:\\projects\\jam";
    writeRuntimeConfig({ version: 1, runtime: { mode: "development", source } }, home);

    expect(readRuntimeConfig(home)).toEqual({
      version: 1,
      runtime: { mode: "development", source },
    });
  });

  it("reports an absent config as undefined rather than throwing", () => {
    expect(readRuntimeConfig(tmp("jam-empty-"))).toBeUndefined();
  });

  it("treats malformed or incomplete config as absent", () => {
    expect(normalizeRuntimeConfig(undefined)).toBeUndefined();
    expect(normalizeRuntimeConfig({})).toBeUndefined();
    expect(normalizeRuntimeConfig({ runtime: { mode: "nonsense" } })).toBeUndefined();
    // development without a source is unusable
    expect(normalizeRuntimeConfig({ runtime: { mode: "development" } })).toBeUndefined();
    expect(normalizeRuntimeConfig({ runtime: { mode: "development", source: "  " } })).toBeUndefined();
  });

  it("never persists credentials or project keys", () => {
    const home = tmp("jam-home-");
    const path = writeRuntimeConfig({ version: 1, runtime: { mode: "package" } }, home);
    const contents = require("node:fs").readFileSync(path, "utf8") as string;

    expect(contents).not.toMatch(/token|password|secret|JIRA_API/i);
    expect(contents).not.toMatch(/project\s*:/);
  });
});

describe("package runtime", () => {
  it("prefers a server installed next to this launcher, run directly", () => {
    // The workspace itself has the server installed, so the default resolver
    // finds it - which is exactly what a persistent global install looks like.
    const resolved = resolvePackageRuntime();

    expect(resolved.mode).toBe("package");
    expect(resolved.executable.command).toBe(process.execPath);
    expect(resolved.executable.args[0]).toMatch(/index\.js$/);
    // The version is read from the resolved install, not assumed from release
    // constants - `runtime status` must report what would actually run.
    expect(resolved.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("still resolves the installed server's real location and version", () => {
    const local = resolveInstalledServer();

    expect(local).toBeDefined();
    expect(local!.entry).toMatch(/index\.js$/);
    expect(local!.version).toBe(SERVER_VERSION);
  });

  it("falls back to an exactly-pinned npx spec when no server is installed", () => {
    expect(resolveInstalledServer(() => { throw new Error("not found"); })).toBeUndefined();

    // With no local server the executable is the zero-install form. The pin
    // rules stay: never a floating tag.
    expect(SERVER_PACKAGE_SPEC).not.toContain("latest");
    expect(SERVER_PACKAGE_SPEC).toMatch(/@\d+\.\d+\.\d+$/);
    expect(SERVER_PACKAGE_SPEC).toBe(`@jam-mcp/server@${SERVER_VERSION}`);
  });
});

describe("development runtime", () => {
  it("resolves a built checkout to a direct node invocation", () => {
    const root = fakeCheckout({ version: "1.2.3" });
    const resolved = resolveDevelopmentRuntime(root);

    expect(resolved.mode).toBe("development");
    expect(resolved.version).toBe("1.2.3");
    expect(resolved.executable.command).toBe(process.execPath);
    expect(resolved.executable.args[0]).toBe(join(root, SERVER_ENTRY_RELATIVE));
  });

  it.each([
    ["a path that does not exist", () => join(tmp("jam-missing-"), "nope"), /does not exist/],
    ["a directory that is not a checkout", () => tmp("jam-bare-"), /does not look like a JAM checkout/],
    ["a checkout that was never built", () => fakeCheckout({ built: false }), /has not been built/],
    [
      "a package that is not the JAM server",
      () => fakeCheckout({ name: "@someone/else" }),
      /is not @jam-mcp\/server/,
    ],
  ])("rejects %s with an actionable message", (_label, make, pattern) => {
    expect(() => resolveDevelopmentRuntime(make())).toThrowError(
      expect.objectContaining({ code: "JAM_DEVELOPMENT_SOURCE_INVALID" }),
    );
    expect(() => resolveDevelopmentRuntime(make())).toThrowError(pattern as RegExp);
  });
});

describe("resolveRuntime", () => {
  it("switches between modes purely from config, with no project involvement", () => {
    const root = fakeCheckout();

    expect(resolveRuntime({ version: 1, runtime: { mode: "package" } }).mode).toBe("package");
    expect(resolveRuntime({ version: 1, runtime: { mode: "development", source: root } }).mode).toBe(
      "development",
    );
  });

  it("explains how to configure a runtime when none exists", () => {
    expect(() => resolveConfiguredRuntime(tmp("jam-unconfigured-"))).toThrowError(
      expect.objectContaining({ code: "JAM_RUNTIME_CONFIG_MISSING" }),
    );
  });

  it("resolves through the user's on-disk config once written", () => {
    const home = tmp("jam-home-");
    writeRuntimeConfig({ version: 1, runtime: { mode: "package" } }, home);

    expect(resolveConfiguredRuntime(home).mode).toBe("package");
  });
});
