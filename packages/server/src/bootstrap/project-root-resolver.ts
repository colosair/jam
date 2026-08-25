import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_RELATIVE_PATH } from "../config/load-config.js";

export type ProjectRoot = {
  root: string;
  /** True when an existing `.jira-agent/project.yaml` was found at `root`. */
  hasConfig: boolean;
};

/**
 * Nearest-ancestor search from `startDir`:
 *   1. the nearest `.jira-agent/project.yaml` - that directory is the root
 *   2. else the nearest `.git` - a FILE in a worktree/submodule counts just as
 *      much as a directory, since `existsSync` doesn't care which
 *   3. else `startDir` itself, so JAM still boots outside any repo
 *
 * This is deliberately the nearest ancestor, not the outermost repo root - a
 * project nested inside a monorepo should not have JAM walk past its own
 * `.git` into the monorepo's.
 */
export function resolveProjectRoot(startDir: string = process.cwd()): ProjectRoot {
  let dir = resolve(startDir);
  let gitRoot: string | undefined;

  for (;;) {
    if (existsSync(join(dir, CONFIG_RELATIVE_PATH))) {
      return { root: dir, hasConfig: true };
    }
    if (gitRoot === undefined && existsSync(join(dir, ".git"))) {
      gitRoot = dir;
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return { root: gitRoot ?? resolve(startDir), hasConfig: false };
}
