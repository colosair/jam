import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { relative } from "node:path";
import { normalizePath } from "./project-config-bootstrapper.js";

/**
 * Reads a repository's `origin` remote. Injected by tests so no test depends
 * on the checkout it happens to run in.
 */
export type GitRemoteFn = (root: string) => string | undefined;

/** Local file read, not a network call - a second is already generous. */
const GIT_TIMEOUT_MS = 2_000;

/**
 * Ask git for `origin`, and treat every failure as "no remote".
 *
 * git missing, not a repository, no `origin`, a stalled filesystem - all of
 * them mean the same thing to a caller, and none of them is worth an error or
 * a log line. `shell: false` unlike the npm probe in `migration-target.ts`:
 * git is a real executable, so routing it through a shell would only add
 * quoting hazards around the user's path.
 */
export const readGitRemote: GitRemoteFn = (root) => {
  const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: root,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    shell: false,
  });
  if (result.error || result.status !== 0) return undefined;
  const url = result.stdout?.trim();
  return url ? url : undefined;
};

const DEFAULT_PORTS: Record<string, string> = {
  http: "80",
  https: "443",
  ssh: "22",
  git: "9418",
};

/**
 * One repository, one identity, whichever URL form was cloned.
 *
 * `git@host:org/repo.git` and `https://host/org/repo` are the same repository
 * and must produce the same string, or a binding made from one clone would be
 * invisible from another.
 *
 * Two rules are load-bearing rather than cosmetic:
 *
 * - **Any userinfo is dropped.** A remote can carry `user:token@`, and a token
 *   must never reach `~/.jam/projects.yaml`, a log line or telemetry.
 * - **An explicit non-default port is kept.** `git.example.com:8443/org/repo`
 *   and `git.example.com/org/repo` may be different services - self-hosted
 *   GitLab makes that ordinary - so only a port that is the scheme's own
 *   default is dropped.
 */
export function canonicalRemote(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    const host = parsed.hostname.toLowerCase();
    if (!host) return undefined;
    const scheme = parsed.protocol.replace(":", "").toLowerCase();
    // WHATWG already drops http/https default ports; this covers ssh and git.
    const port = parsed.port && parsed.port !== DEFAULT_PORTS[scheme] ? `:${parsed.port}` : "";
    const path = cleanPath(parsed.pathname);
    return path ? `${host}${port}/${path}` : undefined;
  }

  // scp-like: [user@]host:path. The text after the colon is a path, never a
  // port - reading it as one would turn org/repo into a port number.
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
  if (scp) {
    const host = scp[1]!.toLowerCase();
    const path = cleanPath(scp[2]!);
    return path ? `${host}/${path}` : undefined;
  }

  return undefined;
}

function cleanPath(raw: string): string {
  return raw
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

export type WorkspaceIdentityOptions = {
  /** The repository root, when `root` is inside one. */
  gitRoot?: string;
  /** Injected by tests. */
  git?: GitRemoteFn;
};

/**
 * A stable id for "this workspace", used to bind it to a Jira project.
 *
 * Prefers the canonical remote plus the project's offset inside the
 * repository, so two clones of one repo share a binding and two packages in a
 * monorepo do not. Falls back to the normalised absolute path when there is no
 * remote to ask about - which is honest about its ceiling: a folder that moves
 * loses its binding.
 *
 * No realpath: the preset matcher already compares non-realpathed absolute
 * paths, and resolving symlinks only here would create a case where a preset
 * matches and a binding does not.
 */
export function workspaceIdentity(root: string, options: WorkspaceIdentityOptions = {}): string {
  const git = options.git ?? readGitRemote;
  const gitRoot = options.gitRoot;
  const remote = gitRoot ? canonicalRemote(git(gitRoot) ?? "") : undefined;

  if (remote) {
    const offset = toPosix(relative(gitRoot!, root));
    return offset ? `git:${remote}#${offset}` : `git:${remote}`;
  }

  return `path:${toPosix(normalizePath(root))}`;
}

function toPosix(p: string): string {
  const forward = p.split("\\").join("/");
  return platform() === "win32" ? forward.toLowerCase() : forward;
}
