import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LauncherError } from "./errors.js";
import { portableBootstrapCommand } from "./release.js";
import type { ResolvedRuntime } from "./runtime-resolver.js";

/** Where the server's built entry point lives inside a JAM checkout. */
export const SERVER_ENTRY_RELATIVE = join("packages", "server", "dist", "index.js");
const SERVER_MANIFEST_RELATIVE = join("packages", "server", "package.json");

/**
 * Development mode: run a local JAM checkout directly.
 *
 * Validated rather than trusted - a stale path in the user's runtime config
 * would otherwise surface as a confusing "cannot find module" from deep inside
 * node, long after the point where it could be explained.
 */
export function resolveDevelopmentRuntime(source: string): ResolvedRuntime {
  const root = resolve(source);

  if (!existsSync(root)) {
    throw invalid(`The configured JAM source directory does not exist: ${root}`);
  }
  if (!existsSync(join(root, "package.json"))) {
    throw invalid(`No package.json at ${root} - this does not look like a JAM checkout.`);
  }

  const manifestPath = join(root, SERVER_MANIFEST_RELATIVE);
  if (!existsSync(manifestPath)) {
    throw invalid(
      `No ${SERVER_MANIFEST_RELATIVE} under ${root} - this does not look like a JAM checkout.`,
    );
  }

  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown }).name;
  } catch {
    throw invalid(`Could not read ${manifestPath}.`);
  }
  if (name !== "@jam-mcp/server") {
    throw invalid(`${manifestPath} is not @jam-mcp/server (found ${String(name)}).`);
  }

  const entry = join(root, SERVER_ENTRY_RELATIVE);
  if (!existsSync(entry)) {
    // `--prefix` rather than `npm run build`: the launcher runs in the
    // application's directory, not JAM's, so a bare build command would build
    // whatever the user happens to be working on. Naming the checkout also
    // avoids `cd ... && ...`, which cmd.exe does not accept.
    throw new LauncherError(
      "JAM_DEVELOPMENT_SOURCE_INVALID",
      `The configured JAM checkout has not been built: ${root} (${SERVER_ENTRY_RELATIVE} is missing).`,
      `npm --prefix ${root} run build`,
    );
  }

  const version = readVersion(manifestPath);
  return {
    mode: "development",
    ...(version ? { version } : { version: "unknown" }),
    executable: { command: process.execPath, args: [entry] },
  };
}

function readVersion(manifestPath: string): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

function invalid(message: string): LauncherError {
  // Not `jam runtime use development`: a broken runtime config is exactly the
  // state in which the launcher cannot dispatch, so the remedy has to be one
  // that needs neither a configured runtime nor a global install.
  return new LauncherError(
    "JAM_DEVELOPMENT_SOURCE_INVALID",
    message,
    portableBootstrapCommand("runtime use development <path>"),
  );
}
