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
  /** The entry runs the global `jam` executable rather than an npx pin. */
  entryBare?: boolean;
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

/**
 * What a persistent install registers: the global `jam` executable, no
 * package runner, no cache. Only offered when the measured global launcher
 * is exactly this release (preferBareRegistration) - registering bare over
 * an older global would silently downgrade the served toolset.
 */
const LAUNCH_BARE: string[] = ["--", "jam", "serve"];

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

export function hostRegistration(
  id: HostId,
  options: { bare?: boolean } = {},
): HostCommand | undefined {
  const adapter = ADAPTERS.find((a) => a.id === id);
  if (!adapter) return undefined;
  if (!options.bare) return adapter.register;
  const at = adapter.register.args.indexOf("--");
  return { command: adapter.register.command, args: [...adapter.register.args.slice(0, at), ...LAUNCH_BARE] };
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
 * Does this entry run the persistent `jam` executable rather than an npx pin?
 *
 * `jam: jam serve`, `jam: /usr/local/bin/jam serve`, `jam: C:\...\jam.cmd serve`
 * all count; an npx line never does - its command token is `npx`. A bare entry
 * carries no version in the listing, so its staleness has to be measured from
 * the executable it would actually run (bareJamVersion), not from the line.
 */
export function isBareJamEntry(line: string): boolean {
  const command = line.replace(/^\s*jam\s*:?\s*/, "");
  return /^(?:\S*[\\/])?jam(?:\.cmd|\.exe)?["']?\s+serve\b/i.test(command);
}

/**
 * The version a bare `jam` registration actually runs, measured by asking the
 * executable itself. `runtime status --json` answers from ~/.jam/config.yaml
 * and the resolved build - the same resolution the registered entry performs.
 *
 * undefined when `jam` is not on PATH or does not answer: a registration that
 * cannot be measured counts as stale, same as an unreadable pin.
 */
export function bareJamVersion(run: HostRunner = defaultHostRunner): string | undefined {
  const result = run({ command: "jam", args: ["runtime", "status", "--json"] });
  if (result.failed || result.status !== 0) return undefined;
  try {
    const version = (JSON.parse(result.stdout) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Is this measured launcher version the one this release registers? */
export function preferBareRegistration(version: string | undefined): boolean {
  return version !== undefined && version === EXPECTED_LAUNCHER_VERSION;
}

/**
 * Does this entry run the launcher this release registers?
 *
 * An npx pin answers from the line itself. A bare `jam` line names no version,
 * so the caller passes what the executable measured (`bareVersion`) - without
 * it, bare stays stale. Anything else - an older pin, an unpinned spec, a line
 * whose command JAM cannot read - counts as stale. That direction is
 * deliberate: `mcp add` rewrites the same entry, so a needless repair costs
 * one command, while a missed one leaves the agent talking to a server nobody
 * tested it against.
 */
export function isEntryStale(line: string, bareVersion?: string): boolean {
  const pinned = entryLauncherVersion(line);
  if (pinned !== undefined) return pinned !== EXPECTED_LAUNCHER_VERSION;
  if (isBareJamEntry(line)) return bareVersion !== EXPECTED_LAUNCHER_VERSION;
  return true;
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
  let bareCache: { version: string | undefined } | undefined;
  return ADAPTERS.map((adapter) => {
    const result = run(adapter.probe);
    if (result.failed || result.status !== 0) {
      return { id: adapter.id, cliAvailable: false, hasJamEntry: false };
    }
    const line = jamEntryLine(result.stdout);
    if (!line) return { id: adapter.id, cliAvailable: true, hasJamEntry: false };
    // A bare entry's version lives in the executable, not the line - measure
    // it once, only when a bare entry actually shows up.
    const bare = isBareJamEntry(line);
    const version = entryLauncherVersion(line) ?? (bare ? measuredBare() : undefined);
    return {
      id: adapter.id,
      cliAvailable: true,
      hasJamEntry: true,
      ...(version ? { entryVersion: version } : {}),
      ...(bare ? { entryBare: true } : {}),
      entryStale: isEntryStale(line, version),
    };
  });

  function measuredBare(): string | undefined {
    bareCache ??= { version: bareJamVersion(run) };
    return bareCache.version;
  }
}

/** How a person would do it by hand, for the hosts JAM could not reach. */
export function describeHostCommand({ command, args }: HostCommand): string {
  return [command, ...args].join(" ");
}
