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
  /**
   * The launcher pin that entry actually runs, when the listing shows it.
   *
   * An entry existing is not the same as an entry being current: a pin written
   * by an older release keeps running that release's server, which serves a
   * different set of tools. Reading only the name made a stale registration
   * indistinguishable from a good one, and setup then reported
   * `already_configured` over it.
   */
  entryVersion?: string;
  /** The entry is present but does not run the launcher this release registers. */
  entryStale?: boolean;
};

export type HostRunResult = {
  status: number | null;
  /** True when the command could not be run at all. */
  failed: boolean;
  stdout: string;
};

/** Injected by tests. Nothing in this module may reach a real CLI unasked. */
export type HostRunner = (command: HostCommand) => HostRunResult;

/**
 * These boot a whole Node CLI, and Claude Code health-checks every configured
 * server while listing, which is seconds rather than milliseconds.
 */
const HOST_TIMEOUT_MS = 20_000;

export const defaultHostRunner: HostRunner = ({ command, args }) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: HOST_TIMEOUT_MS,
    // Both CLIs are npm shims on Windows, and Node refuses to spawn a .cmd
    // without a shell. Every argument JAM passes is a bare token - no JSON, no
    // spaces - precisely so this cannot become a quoting hazard.
    shell: process.platform === "win32",
  });
  if (result.error) return { status: null, failed: true, stdout: "" };
  return { status: result.status, failed: false, stdout: result.stdout ?? "" };
};

type HostAdapter = {
  id: HostId;
  /** Read-only: what does this host currently have? */
  probe: HostCommand;
  /** The registration itself, run only by apply. */
  register: HostCommand;
  /**
   * How to take the existing entry away first.
   *
   * `mcp add` was assumed to overwrite; it does not - Claude Code answers
   * "MCP server jam already exists in user config" and changes nothing, which
   * is why a stale pin survived every re-run of setup. A repair removes, then
   * adds.
   */
  unregister: HostCommand;
};

/**
 * `add`, not `add-json`: the JSON form would put a quoted blob through a
 * Windows shell, and every argument here is a bare token instead.
 */
const LAUNCH: string[] = ["--", JAM_MCP_ENTRY.command, ...JAM_MCP_ENTRY.args];

const ADAPTERS: HostAdapter[] = [
  {
    id: "claude-code",
    probe: { command: "claude", args: ["mcp", "list"] },
    // `-s user` is the whole point: registered for this user on this machine,
    // not for whichever project happens to be open.
    register: { command: "claude", args: ["mcp", "add", "jam", "-s", "user", ...LAUNCH] },
    unregister: { command: "claude", args: ["mcp", "remove", "jam", "-s", "user"] },
  },
  {
    id: "codex",
    probe: { command: "codex", args: ["mcp", "list"] },
    register: { command: "codex", args: ["mcp", "add", "jam", ...LAUNCH] },
    unregister: { command: "codex", args: ["mcp", "remove", "jam"] },
  },
];

export function hostRegistration(id: HostId): HostCommand | undefined {
  return ADAPTERS.find((a) => a.id === id)?.register;
}

/** The removal that has to precede re-registering an entry this host already has. */
export function hostUnregistration(id: HostId): HostCommand | undefined {
  return ADAPTERS.find((a) => a.id === id)?.unregister;
}

const ANSI = /\[[0-9;?]*[A-Za-z]/g;

/**
 * Is `jam` in this listing?
 *
 * Both CLIs exit 0 whether or not a server exists, so the exit code says
 * nothing and the name column is the only signal available. Matched as the
 * first token of a line so a server called `jam-something`, or the word
 * appearing in a URL, cannot be mistaken for it.
 *
 * ponytail: this reads another program's table. If either changes its listing
 * format the effect is a redundant registration attempt, not a wrong one -
 * `mcp add` on an existing entry writes the same launcher line back.
 */
export function listsJamEntry(stdout: string): boolean {
  return jamEntryLine(stdout) !== null;
}

/** The listing line for `jam`, ANSI stripped, or null when there is none. */
export function jamEntryLine(stdout: string): string | null {
  const line = stdout
    .replace(ANSI, "")
    .split(/\r?\n/)
    .find((candidate) => /^\s*jam(?=[\s:])/.test(candidate));
  return line ?? null;
}

/** The launcher version a listing line runs, when the line names one. */
export function entryLauncherVersion(line: string): string | undefined {
  return /@jam-mcp\/launcher@([^\s"']+)/.exec(line)?.[1];
}

/**
 * Does this entry run the launcher this release registers?
 *
 * Anything else - an older pin, an unpinned spec, a line whose command JAM
 * cannot read - counts as stale. That direction is deliberate: `mcp add`
 * rewrites the same entry, so a needless repair costs one command, while a
 * missed one leaves the agent talking to a server nobody tested it against.
 */
export function isEntryStale(line: string): boolean {
  return entryLauncherVersion(line) !== EXPECTED_LAUNCHER_VERSION;
}

const EXPECTED_LAUNCHER_VERSION = entryLauncherVersion(JAM_MCP_ENTRY.args.join(" "));

/**
 * Ask each host what it has, and whether it is there at all.
 *
 * Read-only by construction: `mcp list` reports. A host that cannot be reached
 * is recorded as unavailable rather than assumed empty - so planning has
 * something to refuse rather than something to guess.
 */
export function detectHosts(run: HostRunner = defaultHostRunner): HostState[] {
  // The wizard re-detects after each step, and Claude Code health-checks every
  // configured server while listing - seconds each time. The answer cannot
  // change inside one command, so it is asked once. Only the real runner is
  // cached; an injected one is a test, and must always be called.
  if (run === defaultHostRunner && cachedHosts) return cachedHosts;

  const probed = probeHosts(run);
  if (run === defaultHostRunner) cachedHosts = probed;
  return probed;
}

let cachedHosts: HostState[] | undefined;

function probeHosts(run: HostRunner): HostState[] {
  return ADAPTERS.map((adapter) => {
    const result = run(adapter.probe);
    if (result.failed || result.status !== 0) {
      return { id: adapter.id, cliAvailable: false, hasJamEntry: false };
    }
    const line = jamEntryLine(result.stdout);
    if (!line) return { id: adapter.id, cliAvailable: true, hasJamEntry: false };
    const version = entryLauncherVersion(line);
    return {
      id: adapter.id,
      cliAvailable: true,
      hasJamEntry: true,
      ...(version ? { entryVersion: version } : {}),
      entryStale: isEntryStale(line),
    };
  });
}

/** How a person would do it by hand, for the hosts JAM could not reach. */
export function describeHostCommand({ command, args }: HostCommand): string {
  return [command, ...args].join(" ");
}
