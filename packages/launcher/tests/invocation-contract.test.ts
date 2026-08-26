import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import bootstrapManifest from "../../bootstrap/package.json" with { type: "json" };
import serverManifest from "../../server/package.json" with { type: "json" };
import manifest from "../package.json" with { type: "json" };
import { resolveDevelopmentRuntime } from "../src/development-runtime.js";
import { LauncherError } from "../src/errors.js";
import {
  BOOTSTRAP_PACKAGE_SPEC,
  LAUNCHER_PACKAGE_SPEC,
  SERVER_PACKAGE_SPEC,
  SERVER_VERSION,
  portableBootstrapCommand,
} from "../src/release.js";
import { BOOTSTRAP_INIT_COMMAND } from "../src/runtime-resolver.js";

/**
 * The invocation contract.
 *
 * JAM tells people and machines what to run. A person may be told `jam`, which
 * exists only if they took the optional global install; a machine must be told
 * something that works on a bare machine. These tests pin that split, because
 * the difference is invisible on a developer's own laptop - where `jam` is on
 * PATH and every command appears to work.
 */

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function checkout(options: { built: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "jam-checkout-"));
  created.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "jam-monorepo" }));
  const server = join(root, "packages", "server");
  mkdirSync(server, { recursive: true });
  writeFileSync(
    join(server, "package.json"),
    JSON.stringify({ name: "@jam-mcp/server", version: SERVER_VERSION }),
  );
  if (options.built) {
    mkdirSync(join(server, "dist"), { recursive: true });
    writeFileSync(join(server, "dist", "index.js"), "");
  }
  return root;
}

describe("the launcher ships the optional `jam` façade", () => {
  it("installs under both names from one entry point", () => {
    expect(manifest.bin).toEqual({ jam: "dist/cli.js", "jam-launcher": "dist/cli.js" });
  });

  it("is the only package that claims the name `jam`", () => {
    // Both the launcher and the server once installed a bin called `jam`, and
    // whichever npm linked last silently won. `jam` has to be the dispatcher:
    // a global install must still honour the runtime the user chose, not pin
    // them to whichever server build happened to land on PATH.
    const names = [manifest.bin, serverManifest.bin, bootstrapManifest.bin].flatMap((bin) =>
      Object.keys(bin),
    );
    expect(names.filter((name) => name === "jam")).toEqual(["jam"]);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(manifest.bin)).toContain("jam");
  });

  it("keeps the whole release on one version", () => {
    expect(manifest.version).toBe(SERVER_VERSION);
    expect(SERVER_PACKAGE_SPEC).toBe(`@jam-mcp/server@${SERVER_VERSION}`);
    expect(LAUNCHER_PACKAGE_SPEC).toBe(`@jam-mcp/launcher@${SERVER_VERSION}`);
    expect(BOOTSTRAP_PACKAGE_SPEC).toBe(`@jam-mcp/bootstrap@${SERVER_VERSION}`);
  });
});

describe("commands JAM hands to a machine", () => {
  it("assume nothing is installed", () => {
    const command = portableBootstrapCommand("runtime use package");
    expect(command).toBe(`npx --yes @jam-mcp/bootstrap@${SERVER_VERSION} runtime use package`);
    expect(command.startsWith("jam ")).toBe(false);
  });

  it("pin an exact version, never a floating tag", () => {
    for (const spec of [SERVER_PACKAGE_SPEC, LAUNCHER_PACKAGE_SPEC, BOOTSTRAP_PACKAGE_SPEC]) {
      expect(spec).not.toMatch(/@(latest|next)$/);
      expect(spec).toMatch(/@\d+\.\d+\.\d+$/);
    }
  });

  it("route a missing runtime config through bootstrap, which needs no runtime config", () => {
    expect(BOOTSTRAP_INIT_COMMAND).toBe(`npx --yes @jam-mcp/bootstrap@${SERVER_VERSION} init`);
  });
});

describe("an unbuilt development checkout", () => {
  it("is reported by path, so the remedy cannot build the wrong repository", () => {
    const root = checkout({ built: false });

    let error: unknown;
    try {
      resolveDevelopmentRuntime(root);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(LauncherError);
    const launcherError = error as LauncherError;
    expect(launcherError.code).toBe("JAM_DEVELOPMENT_SOURCE_INVALID");
    expect(launcherError.message).toContain(root);
    // The launcher runs in the application's directory, not JAM's. A bare
    // `npm run build` there would build whatever the user is working on.
    expect(launcherError.nextCommand).toBe(`npm --prefix ${root} run build`);
    expect(launcherError.nextCommand).not.toBe("npm run build");
  });

  it("still resolves once it is built", () => {
    const root = checkout({ built: true });
    const runtime = resolveDevelopmentRuntime(root);
    expect(runtime.mode).toBe("development");
    expect(runtime.version).toBe(SERVER_VERSION);
  });

  it("sends an unusable source path to bootstrap rather than to a `jam` that may not exist", () => {
    let error: unknown;
    try {
      resolveDevelopmentRuntime(join(tmpdir(), "jam-does-not-exist-", String(process.pid)));
    } catch (err) {
      error = err;
    }
    expect((error as LauncherError).nextCommand).toBe(
      portableBootstrapCommand("runtime use development <path>"),
    );
  });
});
