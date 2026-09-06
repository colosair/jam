/**
 * Reading Jira without the MCP channel.
 *
 * JAM's reads have lived only behind MCP tools. That is the right home when the
 * agent's session already has them - but a session that registers JAM cannot be
 * shown the new tools: Claude Code has no reload surface (`claude mcp` offers
 * add / get / list / login / remove / reset-project-choices / serve, and nothing
 * that re-reads registrations for a running session). So the agent that just
 * installed JAM has to wait for its next session before it can read anything.
 *
 * What it did instead was worse: it answered Jira questions from whatever was at
 * hand - git log, the code host, project documents - which is the exact
 * substitution JAM exists to prevent.
 *
 * This is the same read, addressed differently. `search` / `context` / `full`
 * call the same application functions the tools call, with the same deps, the
 * same policies and the same `meta`. Nothing here re-implements a read, and
 * nothing here is a second source of truth.
 *
 * Contract, enforced by tests:
 *   stdout - one JSON document and nothing else, no ANSI, no prompts
 *   stderr - diagnostics only
 */

import { getFullIssueContext } from "../application/get-full-issue-context.js";
import { getIssueContext } from "../application/get-issue-context.js";
import { searchIssues } from "../application/search-issues.js";
import { buildDeps, type BuildDepsOptions, type JamDeps } from "../deps.js";
import { toJamError } from "../domain/errors.js";

export const JIRA_READ_USAGE = `Usage:
  jam jira search <jql> [--scope preview|complete]
  jam jira context <KEY> [KEY...]
  jam jira full <KEY> [KEY...]

Reads only. Output is one JSON document on stdout - the same result the MCP
tools return, for a session that cannot see them yet.
`;

export type JiraReadOptions = BuildDepsOptions & {
  /** Injected by tests so no test reaches a real Jira. */
  deps?: JamDeps;
  /** Where the JSON document goes. Defaults to stdout. */
  write?: (text: string) => void;
  /** Where diagnostics go. Defaults to stderr. */
  warn?: (text: string) => void;
};

/** `--scope complete` / `--scope=complete`, and nothing invented when absent. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index >= 0) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

const positional = (argv: readonly string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--scope") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    out.push(arg);
  }
  return out;
};

export async function runJiraRead(argv: readonly string[], options: JiraReadOptions = {}): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const warn = options.warn ?? ((text: string) => process.stderr.write(text));
  const [subcommand, ...rest] = argv;

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    warn(JIRA_READ_USAGE);
    return subcommand ? 0 : 1;
  }
  if (subcommand !== "search" && subcommand !== "context" && subcommand !== "full") {
    warn(`Unknown jira command: ${subcommand}\n\n${JIRA_READ_USAGE}`);
    return 1;
  }

  const args = positional(rest);
  if (args.length === 0) {
    warn(subcommand === "search" ? "jam jira search needs a JQL query.\n" : `jam jira ${subcommand} needs at least one issue key.\n`);
    return 1;
  }

  const scope = flagValue(rest, "--scope");
  if (scope !== undefined && scope !== "preview" && scope !== "complete") {
    warn(`--scope is preview|complete (got ${scope}).\n`);
    return 1;
  }

  try {
    const { deps: injected, write: _w, warn: _n, ...depsOptions } = options;
    const deps = injected ?? (await buildDeps(depsOptions));
    const result =
      subcommand === "search"
        ? await searchIssues(deps, { jql: args.join(" "), ...(scope ? { scope } : {}) })
        : subcommand === "context"
          ? await getIssueContext(deps, { issueKeys: args })
          : await getFullIssueContext(deps, { issueKeys: args });
    write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    // The same normalized codes the tools produce - an agent reads one contract,
    // not two.
    write(`${JSON.stringify(toJamError(err).toPayload())}\n`);
    return 1;
  }
}
