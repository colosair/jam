import { spawnSync } from "node:child_process";
import { CREDENTIAL_ENV_KEYS, type CredentialValueSource, type RawCredentialValues } from "./process-env.js";

export type RegQueryFn = (name: string) => string | undefined;

/**
 * Reads Jira credentials from the Windows *User* environment (HKCU\Environment)
 * rather than the current process's environment.
 *
 * This exists because a shell that had `setx JIRA_API_TOKEN ...` run in it does
 * NOT see the new value until a new process is spawned - but every terminal
 * spawned afterwards, including the one Claude Code's MCP child inherits from,
 * does. Falling back to the registry closes that gap without asking the user
 * to open a fresh terminal.
 *
 * A value read here is never logged, thrown in an error, or written back
 * anywhere - `read()` only returns it to the caller for in-memory use.
 */
export class WindowsUserEnvCredentialSource implements CredentialValueSource {
  constructor(
    private readonly queryFn: RegQueryFn = defaultRegQuery,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  read(): RawCredentialValues {
    if (process.platform !== "win32") return {};
    if (userEnvDisabled(this.env)) return {};

    const out: RawCredentialValues = {};
    for (const key of CREDENTIAL_ENV_KEYS) {
      const value = this.queryFn(key)?.trim();
      if (value) out[key] = value;
    }
    return out;
  }
}

/**
 * Escape hatch for isolated test sandboxes, matching JAM_DISABLE_SECRET_STORE.
 *
 * HKCU\Environment is per-user, not per-HOME, so repointing HOME does not make
 * a sandbox credential-free on Windows: a developer who ran `setx JIRA_API_TOKEN`
 * once has credentials that every process of theirs can see. Without this, a
 * hermetic test would pass or fail depending on whose machine ran it, and
 * "zero HOME" would be mistaken for "zero credentials".
 *
 * Not a user-facing feature. Production never sets it.
 */
const DISABLE_ENV = "JAM_DISABLE_USER_ENV";

export function userEnvDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[DISABLE_ENV]);
}

const VALUE_LINE = /^\s*\S+\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/;

// Built from a char code rather than a literal backslash escape - a lone
// backslash before a letter isn't a recognized JS escape and silently
// disappears, which would quietly turn this into an invalid registry path.
const HKCU_ENVIRONMENT_KEY = ["HKCU", "Environment"].join(String.fromCharCode(92));

function defaultRegQuery(name: string): string | undefined {
  const res = spawnSync("reg.exe", ["query", HKCU_ENVIRONMENT_KEY, "/v", name], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (res.status !== 0 || !res.stdout) return undefined;

  for (const line of res.stdout.split(/\r?\n/)) {
    const match = VALUE_LINE.exec(line);
    if (match) return match[1];
  }
  return undefined;
}
