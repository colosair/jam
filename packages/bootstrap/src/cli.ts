#!/usr/bin/env node
/**
 * `npx --yes @jam-mcp/bootstrap@1.0.0 ...` - the zero-install way in.
 *
 * This package exists so that the first command a person or an agent runs
 * needs nothing installed beforehand. It holds no setup logic of its own: it
 * depends on @jam-mcp/server at an exact version and forwards to the same
 * commands a locally installed `jam` would run. Any decision it made
 * independently would be a second implementation to keep in sync.
 */
import { runJamCommand } from "@jam-mcp/server/cli-entry";

const USAGE = `jam-bootstrap - first-run setup for JAM (Jira Agent MCP)

For a person:
  npx --yes @jam-mcp/bootstrap@1.0.0 init
      Choose how JAM runs on this machine, then wire up the current project.

For a coding agent (stdout is JSON only, never prompts):
  npx --yes @jam-mcp/bootstrap@1.0.0 setup --agent
      Detect, plan, apply what is safe, and verify - stopping only where a
      person is genuinely required (choosing a Jira project, authenticating).

Anything else is forwarded to the JAM CLI unchanged.
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  // `init` is the human-facing name for first-run setup. Everything else is
  // forwarded verbatim so the bootstrap surface never diverges from the CLI.
  const forwarded = command === "init" ? ["setup", ...argv.slice(1)] : argv;
  return runJamCommand(forwarded);
}

main()
  .then((code) => {
    if (code >= 0) process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`[jam] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
