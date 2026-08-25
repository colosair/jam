import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { JamError } from "../domain/errors.js";
import { ProjectConfigSchema, type ProjectConfig } from "./schema.js";

export const CONFIG_RELATIVE_PATH = join(".jira-agent", "project.yaml");

/**
 * Walk up from `startDir` looking for `.jira-agent/project.yaml`.
 * Returns undefined when the project has no JAM config at all.
 */
export function findConfigPath(startDir: string = process.cwd()): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export type LoadedConfig = {
  config: ProjectConfig;
  /** Undefined when defaults were used because no file was found. */
  path?: string;
};

/**
 * A missing config file is not fatal - JAM falls back to schema defaults so a
 * bare `jam serve` still works. A malformed one IS fatal: silently running
 * with the wrong field policy is worse than refusing to start.
 */
export function loadConfig(startDir: string = process.cwd()): LoadedConfig {
  const path = findConfigPath(startDir);
  if (!path) {
    return { config: ProjectConfigSchema.parse({}) };
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new JamError(
      "CONFIG_INVALID",
      `Could not parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { path },
    );
  }

  const parsed = ProjectConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new JamError("CONFIG_INVALID", `Invalid ${path} - ${issues}`, { path });
  }

  return { config: parsed.data, path };
}
