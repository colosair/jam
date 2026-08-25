#!/usr/bin/env node
import { doctor } from "./cli/doctor.js";
import { showRuntime, useRuntime } from "./cli/runtime.js";
import { serve } from "./cli/serve.js";
import { setup } from "./cli/setup.js";
import { runSetupWizard } from "./cli/setup-wizard.js";
import {
  authStatusCommand,
  doctorJsonCommand,
  setupAgentCommand,
  setupApplyCommand,
  setupPlanCommand,
} from "./cli/agent-api.js";
import { toJamError } from "./domain/errors.js";

const USAGE = `jam - Jira Agent MCP

Usage:
  jam serve               Run the MCP server over stdio (default; this is what Claude Code / Codex launch)
  jam doctor              Diagnose config, credentials and Jira connectivity
  jam setup [--project KEY] [--migrate] [--non-interactive]
                          Wire up this project (project.yaml, .mcp.json) and run doctor
  jam runtime             Show which JAM build this machine runs
  jam runtime use package | development <path>
                          Change it (writes ~/.jam/config.yaml only, never a project)

For coding agents and scripts (stdout is JSON only, never prompts):
  jam setup --agent       One shot: detect, plan, apply what is safe, verify
  jam setup plan --json   Report what setup would change, changing nothing
  jam setup apply --non-interactive --json
                          Execute the plan
  jam doctor --json       Health check as structured output
  jam auth status --json  Whether Jira credentials are configured (never their value)

Environment:
  JIRA_BASE_URL     https://your-site.atlassian.net
  JIRA_EMAIL        Atlassian account email
  JIRA_API_TOKEN    Atlassian API token
  JAM_PROJECT_KEY   Jira project key, used by \`jam setup\`/\`jam serve\` when no
                     .jira-agent/project.yaml exists yet

Credentials and JAM_PROJECT_KEY are read from the current shell's environment
first, then (on Windows) from the User environment - so a value set with
\`setx\` works without opening a new terminal.
`;

function findFlagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command ?? "serve") {
    case "serve":
      return serve();

    case "doctor":
      return rest.includes("--json") ? doctorJsonCommand() : doctor();

    case "setup": {
      const explicitKey = findFlagValue(rest, "--project");
      const shared = {
        ...(explicitKey ? { explicitKey } : {}),
        ...(rest.includes("--migrate") ? { migrate: true } : {}),
      };

      // Agent entry points first: each is non-interactive by construction, so
      // no question can ever block an automated caller.
      if (rest.includes("--agent")) return setupAgentCommand(shared);
      if (rest[0] === "plan") return setupPlanCommand(shared);
      if (rest[0] === "apply") return setupApplyCommand(shared);

      // The wizard can ask; the plain path never does.
      return rest.includes("--non-interactive") ? setup(shared) : runSetupWizard(shared);
    }

    case "runtime": {
      const json = rest.includes("--json");
      if (rest[0] === "use") return useRuntime(rest[1], rest[2], { json });
      return showRuntime({ json });
    }

    case "auth": {
      if (rest[0] === "status") return authStatusCommand();
      process.stderr.write("Usage: jam auth status [--json]\n");
      return 1;
    }

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
    // Setting exitCode and letting Node exit naturally (rather than forcing
    // process.exit()) avoids a libuv assertion crash observed on Windows when
    // this process has mixed spawnSync (reg.exe/where) with async fetch calls -
    // a forced exit can race a handle that is still closing.
    if (code >= 0) process.exitCode = code;
  })
  .catch((err) => {
    const jamError = toJamError(err);
    process.stderr.write(`[jam] ${jamError.code}: ${jamError.message}\n`);
    process.exitCode = 1;
  });
