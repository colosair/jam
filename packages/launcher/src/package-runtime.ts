import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SERVER_PACKAGE_SPEC, SERVER_VERSION } from "./release.js";
import type { ResolvedRuntime } from "./runtime-resolver.js";

/**
 * Package mode: prefer a server that is already installed next to this
 * launcher, and only then fall back to npx.
 *
 * The launcher declares the server as an exact dependency, so a persistent
 * install (`npm install -g @jam-mcp/launcher@<exact>`) carries the matching
 * server with it. Running that copy directly under the current Node does two
 * things npx cannot promise: it works on machines where the package runner
 * itself is broken (a real Windows npm 11.6.2 was seen failing to put the
 * cache's .bin on the child PATH — before any JAM code ran), and it starts
 * without a network round trip.
 *
 * The dependency is resolved lazily, at run time, precisely so this package
 * never imports server code: the server already depends on the launcher for
 * its release constants, and a static import here would close that loop.
 */
export function resolvePackageRuntime(): ResolvedRuntime {
  const local = resolveInstalledServer();
  if (local) {
    return {
      mode: "package",
      version: local.version,
      executable: { command: process.execPath, args: [local.entry] },
    };
  }
  // Zero-install path: run the published server through npx at an exact
  // version. `--yes` keeps npx from prompting, which matters because this
  // runs as an MCP child process with no usable terminal.
  return {
    mode: "package",
    version: SERVER_VERSION,
    executable: {
      command: "npx",
      args: ["--yes", SERVER_PACKAGE_SPEC],
    },
  };
}

/** Injected by tests so the suite never depends on what this machine has installed. */
export type ServerResolver = (specifier: string) => string;

export function resolveInstalledServer(
  resolve: ServerResolver = defaultResolve,
): { entry: string; version: string } | undefined {
  try {
    // The package root resolves to dist/index.js — the actual executable
    // entry. `cli-entry` exports the command table but runs nothing on its
    // own; pointing dispatch at it produced a child that exited 0 in silence
    // (the smoke scenario caught exactly that).
    const entry = resolve("@jam-mcp/server");
    // The manifest sits two levels above dist/index.js. Read the version
    // so `runtime status` reports what would actually run, not what this
    // launcher was released with.
    const manifest = join(dirname(dirname(entry)), "package.json");
    const version = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version;
    if (!version) return undefined;
    return { entry, version };
  } catch {
    return undefined;
  }
}

const defaultResolve: ServerResolver = (specifier) => createRequire(import.meta.url).resolve(specifier);
