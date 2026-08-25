#!/usr/bin/env node
import { dispatch } from "./dispatch.js";
import { LauncherError } from "./errors.js";
import { resolveConfiguredRuntime } from "./runtime-resolver.js";

const USAGE = `jam-launcher - resolves and runs the configured JAM runtime

Usage:
  jam-launcher serve      Run the configured JAM runtime (what .mcp.json invokes)
  jam-launcher <command>  Forward any other command to the configured runtime

Runtime selection lives in ~/.jam/config.yaml. Configure it with:
  npx --yes @jam-mcp/bootstrap@1.0.0 init
`;

export async function run(argv: string[]): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    // stderr, not stdout: stdout belongs to the MCP protocol on every code path.
    process.stderr.write(USAGE);
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
