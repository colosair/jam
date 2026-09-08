/**
 * Writing Jira without the MCP channel.
 *
 * The companion to cli/jira-read.ts, for the same reason and with the same
 * shape. A session whose MCP registry came up in a failed state cannot be shown
 * the tools - Claude Code has no reload surface for a running session - so JAM,
 * its credentials and its Jira access can all be healthy while `jira_write_plan`
 * is simply unreachable. Reads were addressed to the shell first; this is the
 * other half.
 *
 * Nothing here is a second write path. `write-plan` and `write-apply` call the
 * same `planWrite` / `applyWritePlan` the tools call, with the same deps, the
 * same project binding, the same whitelist and the same plan store - so a plan
 * made through MCP can be applied here, which is the point when MCP is what
 * broke.
 *
 * The two-call contract is not relaxed for the shell:
 *
 *   write-plan   reads Jira, decides what is possible, writes nothing
 *   write-apply  takes a planId and nothing else, then reads the result back
 *
 * There is deliberately no `jam jira comment` or `jam jira close`. A shortcut
 * that skips planning is exactly what the write plane exists to prevent, and
 * being on a terminal does not change that.
 *
 * Contract, enforced by tests:
 *   stdout - one JSON document and nothing else, no ANSI, no prompts
 *   stderr - diagnostics only
 *
 * `write-apply` never asks for confirmation. What to write was settled when the
 * plan was made; a prompt here would be a second approval step, which is a
 * different feature and not this one.
 */

import { applyWritePlan } from "../application/apply-write.js";
import { planWrite } from "../application/plan-write.js";
import { buildDeps, type BuildDepsOptions, type JamDeps } from "../deps.js";
import { toJamError } from "../domain/errors.js";
import { WRITE_OPERATIONS } from "../domain/write.js";

export const JIRA_WRITE_USAGE = `Usage:
  jam jira write-plan --operation <op> [--key KEY] --input '<json>'
  jam jira write-apply <planId>

Operations: ${WRITE_OPERATIONS.join(", ")}
  issue.create takes no --key; every other operation needs one.

Two calls, always. write-plan changes nothing and returns a planId; write-apply
takes that planId and nothing else. Output is one JSON document on stdout - the
same receipt the MCP tools return, for a session that cannot see them.
`;

export type JiraWriteOptions = BuildDepsOptions & {
  /** Injected by tests so no test reaches a real Jira. */
  deps?: JamDeps;
  /** Where the JSON document goes. Defaults to stdout. */
  write?: (text: string) => void;
  /** Where diagnostics go. Defaults to stderr. */
  warn?: (text: string) => void;
};

/** `--flag value` / `--flag=value`, and nothing invented when absent. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index >= 0) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

const FLAGS_WITH_VALUES = ["--operation", "--key", "--input"];

const positional = (argv: readonly string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (FLAGS_WITH_VALUES.includes(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    out.push(arg);
  }
  return out;
};

export async function runJiraWrite(
  argv: readonly string[],
  options: JiraWriteOptions = {},
): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const warn = options.warn ?? ((text: string) => process.stderr.write(text));
  const [subcommand, ...rest] = argv;

  if (subcommand !== "write-plan" && subcommand !== "write-apply") {
    warn(`Unknown jira command: ${subcommand ?? "(none)"}\n\n${JIRA_WRITE_USAGE}`);
    return 1;
  }

  // Argument shape is checked here; what the values mean is checked by the
  // application, which is the same judgement the tools get. This file does not
  // decide what a valid operation or input is.
  let request: { kind: "plan"; key?: string; operation: string; input: Record<string, unknown> } | { kind: "apply"; planId: string };

  if (subcommand === "write-plan") {
    const operation = flagValue(rest, "--operation");
    if (!operation) {
      warn(`jam jira write-plan needs --operation.\n\n${JIRA_WRITE_USAGE}`);
      return 1;
    }
    const raw = flagValue(rest, "--input");
    if (raw === undefined) {
      warn(`jam jira write-plan needs --input '<json>'.\n\n${JIRA_WRITE_USAGE}`);
      return 1;
    }
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      warn("--input must be a JSON object.\n");
      return 1;
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      warn("--input must be a JSON object.\n");
      return 1;
    }
    const key = flagValue(rest, "--key");
    request = {
      kind: "plan",
      ...(key ? { key } : {}),
      operation,
      input: input as Record<string, unknown>,
    };
  } else {
    // Exactly one positional and no way to pass anything else. There is no
    // payload flag here, and adding one would be adding a way to write
    // something the plan did not describe.
    const [planId, ...extra] = positional(rest);
    if (!planId || extra.length > 0) {
      warn(`jam jira write-apply takes exactly one planId.\n\n${JIRA_WRITE_USAGE}`);
      return 1;
    }
    request = { kind: "apply", planId };
  }

  try {
    const { deps: injected, write: _w, warn: _n, ...depsOptions } = options;
    const deps = injected ?? (await buildDeps(depsOptions));
    const result =
      request.kind === "plan"
        ? (
            await planWrite(deps, {
              ...(request.key !== undefined ? { key: request.key } : {}),
              operation: request.operation,
              input: request.input,
            })
          ).receipt
        : await applyWritePlan(deps, { planId: request.planId });
    write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    // The same normalized codes the tools produce - an agent reads one contract,
    // not two.
    write(`${JSON.stringify(toJamError(err).toPayload())}\n`);
    return 1;
  }
}
