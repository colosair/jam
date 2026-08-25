import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LauncherError } from "./errors.js";
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
    throw new LauncherError(
      "JAM_DEVELOPMENT_SOURCE_INVALID",
      `JAM source at ${root} has not been built - ${SERVER_ENTRY_RELATIVE} is missing.`,
      "npm run build",
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
  return new LauncherError(
    "JAM_DEVELOPMENT_SOURCE_INVALID",
    message,
    "jam runtime use development <path>",
  );
}
