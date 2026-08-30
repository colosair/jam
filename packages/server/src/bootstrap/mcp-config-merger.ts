import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LAUNCHER_PACKAGE_SPEC } from "@jam-mcp/launcher";

/**
 * The canonical jam entry for a project's `.mcp.json`.
 *
 * Goes through the launcher rather than naming a JAM install directly, so the
 * file says only "this project uses JAM" - which build actually runs is the
 * reader's own choice, in their own ~/.jam/config.yaml. That is what makes
 * this line safe to commit and share across machines.
 *
 * Pinned to an exact version. A floating tag would silently change what a
 * teammate's editor launches.
 */
export { LAUNCHER_PACKAGE_SPEC };

export const JAM_MCP_ENTRY = {
  command: "npx",
  args: ["--yes", LAUNCHER_PACKAGE_SPEC, "serve"],
} as const;

/**
 * Recognise wiring from before the launcher existed: a hard-coded `node` path
 * to one machine's checkout. That works only where it was written, which is
 * why `--migrate` exists.
 *
 * A bare `jam` is deliberately NOT legacy any more. It is what a persistent
 * install (`npm install -g @jam-mcp/launcher@<exact>`) provides, and on a
 * machine whose package runner is broken it is the entry that still works —
 * a real Windows npm was seen failing to start `npx` children at all. Someone
 * who registered it chose it; `--migrate` must not silently rewrite that
 * choice back into the very path that fails there.
 */
export function isLegacyJamEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const { command, args } = entry as { command?: unknown; args?: unknown };

  if (command === "node") return true;
  if (command === "npx" && Array.isArray(args)) {
    return !args.some((arg) => typeof arg === "string" && arg.startsWith("@jam-mcp/launcher@"));
  }
  return false;
}

export type McpMergeResult = {
  path: string;
  /** "created" | "added" | "unchanged" - what actually happened to the file. */
  action: "created" | "added" | "unchanged";
};

export type McpInspection = {
  path: string;
  exists: boolean;
  /** True when the file exists but is not valid JSON - callers must not overwrite it blindly. */
  unreadable: boolean;
  hasJamEntry: boolean;
  /** Entry names other than "jam", which must survive any mutation. */
  otherServers: string[];
  jamEntry?: unknown;
};

/**
 * Read `.mcp.json` without touching it. This is what lets `setup plan` report
 * what it *would* do: the decision is made here once, and apply only writes.
 */
export function inspectMcpConfig(root: string): McpInspection {
  const path = join(root, ".mcp.json");
  if (!existsSync(path)) {
    return { path, exists: false, unreadable: false, hasJamEntry: false, otherServers: [] };
  }

  let parsed: { mcpServers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, unknown> };
  } catch {
    return { path, exists: true, unreadable: true, hasJamEntry: false, otherServers: [] };
  }

  const servers = parsed.mcpServers ?? {};
  const inspection: McpInspection = {
    path,
    exists: true,
    unreadable: false,
    hasJamEntry: Boolean(servers["jam"]),
    otherServers: Object.keys(servers).filter((name) => name !== "jam"),
  };
  if (servers["jam"]) inspection.jamEntry = servers["jam"];
  return inspection;
}

/**
 * Write a jam entry into `.mcp.json`, preserving every other server verbatim.
 *
 * Unconditional by design - the caller decides *whether* to write; this only
 * decides *how*, so that "should I touch this file" lives in exactly one place.
 */
export function writeJamMcpEntry(root: string, entry: unknown = JAM_MCP_ENTRY): string {
  const path = join(root, ".mcp.json");

  let parsed: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Could not parse existing ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const servers = (parsed["mcpServers"] as Record<string, unknown> | undefined) ?? {};
  const merged = { ...parsed, mcpServers: { ...servers, jam: entry } };
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return path;
}

/**
 * Merge the launcher entry into `.mcp.json`, preserving everything else.
 *
 * Deliberately records neither an absolute path to a JAM checkout nor a bare
 * `jam` - the first breaks the moment a teammate clones somewhere else, and
 * the second assumes an optional global install every teammate would have to
 * have made. `npx` at an exact launcher version assumes only npm.
 */
export function mergeMcpConfig(root: string): McpMergeResult {
  const path = join(root, ".mcp.json");

  if (!existsSync(path)) {
    writeFileSync(path, `${JSON.stringify({ mcpServers: { jam: JAM_MCP_ENTRY } }, null, 2)}\n`, "utf8");
    return { path, action: "created" };
  }

  const raw = readFileSync(path, "utf8");
  let parsed: { mcpServers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
  } catch (err) {
    throw new Error(`Could not parse existing ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (parsed.mcpServers?.["jam"]) {
    return { path, action: "unchanged" };
  }

  const merged = {
    ...parsed,
    mcpServers: { ...(parsed.mcpServers ?? {}), jam: JAM_MCP_ENTRY },
  };
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return { path, action: "added" };
}
