#!/usr/bin/env node
import { basename } from "node:path";
import { dispatch } from "./dispatch.js";
import { LauncherError } from "./errors.js";
import { BOOTSTRAP_INIT_COMMAND, resolveConfiguredRuntime } from "./runtime-resolver.js";

/**
 * Whichever name this was invoked under.
 *
 * The same entry point is installed twice: `jam-launcher` names what it is,
 * and `jam` is the short command a person gets from an optional global
 * install. Echoing the invoked name keeps the help text from telling someone
 * to type a command they did not use.
 */
function invokedAs(): string {
  const name = basename(process.argv[1] ?? "jam-launcher").replace(/\.[cm]?js$/, "");
  return name === "cli" ? "jam-launcher" : name;
}

function usage(name: string): string {
  return `${name} - resolves and runs the configured JAM runtime

Usage:
  ${name} serve      Run the configured JAM runtime (what .mcp.json invokes)
  ${name} <command>  Forward any other command to the configured runtime

This is a dispatcher, not JAM itself: every command is handed to the runtime
selected in ~/.jam/config.yaml. Configure that with:
  ${BOOTSTRAP_INIT_COMMAND}
`;
}

export async function run(argv: string[]): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    // stderr, not stdout: stdout belongs to the MCP protocol on every code path.
    process.stderr.write(usage(invokedAs()));
    return 0;
  }

  const runtime = resolveConfiguredRuntime();
  return dispatch(runtime, argv);
}

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof LauncherError) {
      process.stderr.write(`[jam] ${err.code}: ${err.message}\n`);
      if (err.nextCommand) process.stderr.write(`\nRun:\n  ${err.nextCommand}\n`);
    } else {
      process.stderr.write(`[jam] ${err instanceof Error ? err.message : String(err)}\n`);
    }
    process.exitCode = 1;
  });
