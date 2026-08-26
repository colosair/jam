import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { JamError } from "../domain/errors.js";

/**
 * One workspace bound to one Jira project, for this user only.
 *
 * `path` is provenance for the human reading the file - JAM resolves by
 * `workspace` and never by path, so editing it repoints nothing.
 */
export type ProjectBinding = {
  workspace: string;
  key: string;
  path?: string;
};

/**
 * Why reading distinguishes three states rather than returning a list:
 * discovery can shrug at a broken file, but a write must not. Rewriting the
 * whole file from an empty list that actually meant "could not parse" destroys
 * bindings that are still in there.
 */
export type BindingsInspection = {
  path: string;
  status: "absent" | "parsed" | "unreadable";
  bindings: ProjectBinding[];
  /** Set when status is "unreadable". */
  reason?: string;
};

const FILE_VERSION = 1;

const HEADER =
  "# JAM personal project bindings for this user. Safe to edit by hand.\n" +
  "# Never put Jira credentials here.\n" +
  "# `path` is provenance only - JAM matches on `workspace`.\n";

/**
 * User-local, and deliberately separate from `~/.jam/config.yaml`: that file
 * answers which JAM build runs, this one answers which Jira project a
 * workspace belongs to, and neither should move when the other changes.
 */
export function projectBindingsPath(home: string = homedir()): string {
  return join(home, ".jam", "projects.yaml");
}

/** Read-only. Never creates the directory, so `detect` stays free of writes. */
export function inspectProjectBindings(home?: string): BindingsInspection {
  const path = projectBindingsPath(home);
  if (!existsSync(path)) return { path, status: "absent", bindings: [] };

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    return {
      path,
      status: "unreadable",
      bindings: [],
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (!raw || typeof raw !== "object") {
    return { path, status: "unreadable", bindings: [], reason: "not a mapping" };
  }

  const version = (raw as { version?: unknown }).version;
  if (version !== undefined && version !== FILE_VERSION) {
    // A newer file is not a broken one, but this build cannot promise to
    // rewrite it without losing whatever it does not understand.
    return {
      path,
      status: "unreadable",
      bindings: [],
      reason: `version ${String(version)} is not supported by this build`,
    };
  }

  const list = (raw as { bindings?: unknown }).bindings;
  if (list !== undefined && !Array.isArray(list)) {
    return { path, status: "unreadable", bindings: [], reason: "`bindings` is not a list" };
  }

  const bindings: ProjectBinding[] = [];
  for (const entry of (list ?? []) as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const workspace = (entry as { workspace?: unknown }).workspace;
    const key = (entry as { key?: unknown }).key;
    if (typeof workspace !== "string" || !workspace.trim()) continue;
    if (typeof key !== "string" || !key.trim()) continue;
    const path_ = (entry as { path?: unknown }).path;
    bindings.push({
      workspace: workspace.trim(),
      key: key.trim(),
      ...(typeof path_ === "string" && path_.trim() ? { path: path_.trim() } : {}),
    });
  }

  return { path, status: "parsed", bindings };
}

/**
 * Discovery. A damaged file yields no bindings rather than turning every
 * command into an error - the same stance the preset file and the runtime
 * config already take.
 */
export function readProjectBindings(home?: string): ProjectBinding[] {
  return inspectProjectBindings(home).bindings;
}

export function findProjectBinding(
  workspaceId: string,
  home?: string,
): ProjectBinding | undefined {
  return readProjectBindings(home).find((b) => b.workspace === workspaceId);
}

/**
 * Record one binding, preserving every other entry.
 *
 * Fail-closed on a file that exists but will not parse: refusing costs the
 * user one edit, while rewriting would silently drop bindings this build
 * could not read. Same reasoning as `.mcp.json`, which is never overwritten
 * when it does not parse.
 */
export function writeProjectBinding(binding: ProjectBinding, home?: string): string {
  const inspection = inspectProjectBindings(home);
  if (inspection.status === "unreadable") {
    throw new JamError(
      "JAM_BINDINGS_UNREADABLE",
      `Refusing to rewrite ${inspection.path}: ${inspection.reason ?? "it could not be read"}. Fix or remove that file, then try again.`,
      { path: inspection.path },
    );
  }

  const kept = inspection.bindings.filter((b) => b.workspace !== binding.workspace);
  const next = [...kept, binding].sort((a, b) => a.workspace.localeCompare(b.workspace));

  const body = next
    .map((b) => {
      const lines = [`  - workspace: ${JSON.stringify(b.workspace)}`, `    key: ${b.key}`];
      if (b.path) lines.push(`    path: ${JSON.stringify(b.path)}`);
      return lines.join("\n");
    })
    .join("\n");

  mkdirSync(dirname(inspection.path), { recursive: true });
  writeFileSync(
    inspection.path,
    `${HEADER}version: ${FILE_VERSION}\n\nbindings:\n${body}\n`,
    "utf8",
  );
  return inspection.path;
}
