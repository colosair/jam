import { spawnSync } from "node:child_process";
import { JAM_MCP_ENTRY } from "./mcp-config-merger.js";

/**
 * The coding agents JAM knows how to register itself with, for this user
 * rather than for a repository.
 *
 * Both keep user-level MCP registration in a file of their own - Claude Code
 * in `~/.claude.json`, Codex in `~/.codex/config.toml` - and JAM parses
 * neither. Editing another program's live state file is how you corrupt it;
 * each of these ships a command for exactly this, so JAM uses it.
 */
export type HostId = "claude-code" | "codex";

export type HostCommand = {
  command: string;
  args: string[];
};

export type HostState = {
  id: HostId;
  /** Whether the host's own CLI is on PATH and answering. */
  cliAvailable: boolean;
  /** Whether it already has a `jam` entry registered for this user. */
  hasJamEntry: boolean;
};

/** Injected by tests. Nothing in this module may reach a real CLI unasked. */
export type HostRunner = (command: HostCommand) => { status: number | null; failed: boolean };

/** These boot a whole Node CLI, so the budget is the npm probe's, not git's. */
const HOST_TIMEOUT_MS = 10_000;

export const defaultHostRunner: HostRunner = ({ command, args }) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: HOST_TIMEOUT_MS,
    // Both CLIs are npm shims on Windows, which cmd.exe has to resolve.
    shell: process.platform === "win32",
    stdio: "ignore",
  });
  if (result.error) return { status: null, failed: true };
  return { status: result.status, failed: false };
};

type HostAdapter = {
  id: HostId;
  /** Read-only: does this host already know about jam? */
  probe: HostCommand;
  /** The registration itself, run only by apply. */
  register: HostCommand;
};

const ENTRY_JSON = JSON.stringify(JAM_MCP_ENTRY);

const ADAPTERS: HostAdapter[] = [
  {
    id: "claude-code",
    probe: { command: "claude", args: ["mcp", "get", "jam"] },
    // `-s user` is the whole point: registered for this user on this machine,
    // not for whichever project happens to be open.
    register: { command: "claude", args: ["mcp", "add-json", "jam", ENTRY_JSON, "-s", "user"] },
  },
  {
    id: "codex",
    probe: { command: "codex", args: ["mcp", "get", "jam"] },
    register: {
      command: "codex",
      args: ["mcp", "add", "jam", "--", JAM_MCP_ENTRY.command, ...JAM_MCP_ENTRY.args],
    },
  },
];

export function hostRegistration(id: HostId): HostCommand | undefined {
  return ADAPTERS.find((a) => a.id === id)?.register;
}

/**
 * Ask each host whether it exists and whether it already has jam.
 *
 * Read-only by construction: `mcp get` reports, and a host that cannot be
 * reached at all is reported as unavailable rather than assumed empty - so
 * planning has something to refuse rather than something to guess.
 */
export function detectHosts(run: HostRunner = defaultHostRunner): HostState[] {
  return ADAPTERS.map((adapter) => {
    const result = run(adapter.probe);
    if (result.failed) return { id: adapter.id, cliAvailable: false, hasJamEntry: false };
    return {
      id: adapter.id,
      cliAvailable: true,
      hasJamEntry: result.status === 0,
    };
  });
}

/** How a person would do it by hand, for the hosts JAM could not reach. */
export function describeHostCommand({ command, args }: HostCommand): string {
  return [command, ...args.map((a) => (a.includes(" ") || a.includes('"') ? JSON.stringify(a) : a))].join(
    " ",
  );
}
