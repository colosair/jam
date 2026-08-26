import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_RELATIVE_PATH } from "../config/load-config.js";

export type ProjectRoot = {
  root: string;
  /** True when an existing `.jira-agent/project.yaml` was found at `root`. */
  hasConfig: boolean;
  /**
   * The nearest enclosing repository, when there is one. Already found on the
   * way up; reported so workspace identity does not have to walk again.
   */
  gitRoot?: string;
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

  let configRoot: string | undefined;

  for (;;) {
    if (configRoot === undefined && existsSync(join(dir, CONFIG_RELATIVE_PATH))) {
      configRoot = dir;
      // Keep walking only far enough to learn which repository this is in;
      // the config still decides the root.
      if (gitRoot !== undefined) break;
    }
    if (gitRoot === undefined && existsSync(join(dir, ".git"))) {
      gitRoot = dir;
      if (configRoot !== undefined) break;
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const root = configRoot ?? gitRoot ?? resolve(startDir);
  return {
    root,
    hasConfig: configRoot !== undefined,
    ...(gitRoot ? { gitRoot } : {}),
  };
}
