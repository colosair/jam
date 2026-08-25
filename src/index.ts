#!/usr/bin/env node
import { doctor } from "./cli/doctor.js";
import { setup } from "./cli/setup.js";
import { toJamError } from "./domain/errors.js";
import { serve } from "./mcp/stdio.js";

const USAGE = `jam - Jira Agent MCP

Usage:
  jam serve     Run the MCP server over stdio (default; this is what Claude Code / Codex launch)
  jam doctor    Diagnose config, credentials and Jira connectivity
  jam setup     Install, build, then run doctor

Environment:
  JIRA_BASE_URL   https://your-site.atlassian.net
  JIRA_EMAIL      Atlassian account email
  JIRA_API_TOKEN  Atlassian API token
`;

async function main(): Promise<number> {
  const command = process.argv[2] ?? "serve";

  switch (command) {
    case "serve":
      await serve();
      return -1; // stays alive on the stdio transport

    case "doctor":
      return doctor();

    case "setup":
      return setup();

    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

main()
  .then((code) => {
    if (code >= 0) process.exit(code);
  })
  .catch((err) => {
    const jamError = toJamError(err);
    process.stderr.write(`[jam] ${jamError.code}: ${jamError.message}\n`);
    process.exit(1);
  });
