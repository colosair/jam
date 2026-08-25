import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

export type RuntimeMode = "package" | "development";

export type RuntimeConfig = {
  version: 1;
  runtime:
    | { mode: "package" }
    | { mode: "development"; source: string };
};

/**
 * User-local runtime config. This file answers exactly one question - which
 * JAM build should run on this machine - and nothing else.
 *
 * Deliberately never stored here: Jira credentials, Jira project keys, or
 * anything else specific to a single project. Those live in the credential
 * boundary and in each project's own `.jira-agent/project.yaml`, so that
 * switching runtime never touches project state and vice versa.
 */
export function runtimeConfigPath(home: string = homedir()): string {
  return join(home, ".jam", "config.yaml");
}

export function readRuntimeConfig(home?: string): RuntimeConfig | undefined {
  const path = runtimeConfigPath(home);
  if (!existsSync(path)) return undefined;

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  return normalizeRuntimeConfig(raw);
}

/** Returns undefined rather than throwing - an unreadable config is treated as absent. */
export function normalizeRuntimeConfig(raw: unknown): RuntimeConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const runtime = (raw as { runtime?: unknown }).runtime;
  if (!runtime || typeof runtime !== "object") return undefined;

  const mode = (runtime as { mode?: unknown }).mode;
  if (mode === "package") return { version: 1, runtime: { mode: "package" } };

  if (mode === "development") {
    const source = (runtime as { source?: unknown }).source;
    if (typeof source !== "string" || !source.trim()) return undefined;
    return { version: 1, runtime: { mode: "development", source: source.trim() } };
  }

  return undefined;
}

export function writeRuntimeConfig(config: RuntimeConfig, home?: string): string {
  const path = runtimeConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });

  const body =
    config.runtime.mode === "package"
      ? "runtime:\n  mode: package\n"
      : `runtime:\n  mode: development\n  source: ${JSON.stringify(config.runtime.source)}\n`;

  writeFileSync(
    path,
    `# JAM runtime selection for this user. Safe to edit by hand.\n` +
      `# Never put Jira credentials or project keys here.\n` +
      `version: 1\n\n${body}`,
    "utf8",
  );
  return path;
}
