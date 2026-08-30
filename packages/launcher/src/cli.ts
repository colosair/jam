#!/usr/bin/env node
import { basename } from "node:path";
import { dispatch } from "./dispatch.js";
import { LauncherError } from "./errors.js";
import { BOOTSTRAP_INIT_COMMAND, resolveConfiguredRuntime, resolveRuntime } from "./runtime-resolver.js";
import { readRuntimeConfig, writeRuntimeConfig, type RuntimeConfig } from "./runtime-config.js";

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
  ${name} runtime status [--json]
  ${name} runtime use package
  ${name} runtime use development <checkout>
  ${name} <command>  Forward any other command to the configured runtime

This is a dispatcher, not JAM itself: every command except 'runtime' is
handed to the runtime selected in ~/.jam/config.yaml. 'runtime' is answered
here because it is what creates that selection - a first run has nothing to
dispatch to yet. Without one, start from:
  ${BOOTSTRAP_INIT_COMMAND}
`;
}

export async function run(argv: string[]): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    // stderr, not stdout: stdout belongs to the MCP protocol on every code path.
    process.stderr.write(usage(invokedAs()));
    return 0;
  }

  // `runtime` is the one group the launcher answers itself. Dispatching it
  // would be circular: the command that creates ~/.jam/config.yaml cannot
  // require that file to exist first. A fresh machine with only a global
  // launcher used to be stuck here - every command, including `runtime use
  // package`, died on JAM_RUNTIME_CONFIG_MISSING whose remedy was npx.
  if (argv[0] === "runtime") return runRuntime(argv.slice(1));

  const runtime = resolveConfiguredRuntime();
  return dispatch(runtime, argv);
}

function runRuntime(argv: string[]): number {
  const json = argv.includes("--json");
  const positional = argv.filter((a) => a !== "--json");

  if (positional[0] === undefined || positional[0] === "status") {
    const config = readRuntimeConfig();
    if (!config) {
      const payload = { status: "not_configured", nextCommand: `${invokedAs()} runtime use package` };
      process.stderr.write(json ? "" : `runtime: not configured\nRun:\n  ${payload.nextCommand}\n`);
      if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return 1;
    }
    const resolved = resolveRuntime(config);
    const payload = {
      status: "configured",
      mode: resolved.mode,
      version: resolved.version,
      ...(config.runtime.mode === "development" ? { source: config.runtime.source } : {}),
      executable: resolved.executable,
    };
    if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stderr.write(`runtime: ${resolved.mode} (${resolved.version})\n`);
    return 0;
  }

  if (positional[0] === "use" && positional[1] === "package") {
    const path = writeRuntimeConfig({ version: 1, runtime: { mode: "package" } });
    process.stderr.write(`runtime: package\nRecorded in: ${path}\n`);
    return 0;
  }

  if (positional[0] === "use" && positional[1] === "development") {
    const source = positional[2];
    if (!source) {
      process.stderr.write(`Usage: ${invokedAs()} runtime use development <checkout>\n`);
      return 2;
    }
    const config: RuntimeConfig = { version: 1, runtime: { mode: "development", source } };
    // Validate before recording - a selection that cannot resolve would turn
    // every later command into the resolver's error instead of this one.
    try {
      resolveRuntime(config);
    } catch (err) {
      if (err instanceof LauncherError) {
        process.stderr.write(`[jam] ${err.code}: ${err.message}\n`);
        if (err.nextCommand) process.stderr.write(`\nRun:\n  ${err.nextCommand}\n`);
        return 1;
      }
      throw err;
    }
    const path = writeRuntimeConfig(config);
    process.stderr.write(`runtime: development (${source})\nRecorded in: ${path}\n`);
    return 0;
  }

  process.stderr.write(usage(invokedAs()));
  return 2;
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
