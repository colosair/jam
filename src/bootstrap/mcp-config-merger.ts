import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const JAM_MCP_ENTRY = { command: "jam", args: ["serve"] } as const;

export type McpMergeResult = {
  path: string;
  /** "created" | "added" | "unchanged" - what actually happened to the file. */
  action: "created" | "added" | "unchanged";
};

/**
 * Merge a PATH-based JAM entry into `.mcp.json`, preserving everything else.
 *
 * Deliberately does NOT record an absolute path to this JAM checkout - that
 * would break the moment a teammate clones to a different location. `command:
 * "jam"` relies on `jam` being on PATH (see `jam setup`'s PATH check), which is
 * what keeps this file safe to commit and share.
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
