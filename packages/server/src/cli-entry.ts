import { authLoginCommand, authLogoutCommand } from "./cli/auth.js";
import { doctor } from "./cli/doctor.js";
import { showRuntime, useRuntime } from "./cli/runtime.js";
import { serve } from "./cli/serve.js";
import { setup } from "./cli/setup.js";
import { runSetupWizard } from "./cli/setup-wizard.js";
import { reportPromptError, Ui } from "./cli/ui.js";
import {
  authStatusCommand,
  doctorJsonCommand,
  setupAgentCommand,
  setupApplyCommand,
  setupPlanCommand,
} from "./cli/agent-api.js";

/**
 * Command dispatch for the JAM CLI, separated from the bin so other entry
 * points (notably @jam-mcp/bootstrap) can forward to exactly these commands
 * instead of reimplementing them.
 */
export const USAGE = `jam - Jira Agent MCP

Usage:
  jam serve               Run the MCP server over stdio (default; this is what Claude Code / Codex launch)
  jam doctor              Diagnose config, credentials and Jira connectivity
  jam setup [--project KEY] [--migrate] [--non-interactive]
                          Wire up this project (project.yaml, .mcp.json) and run doctor
  jam runtime             Show which JAM build this machine runs
  jam runtime use package | development <path>
                          Change it (writes ~/.jam/config.yaml only, never a project)
  jam auth login          Store Jira credentials in this user's OS secret store
  jam auth logout         Remove them again

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

/**
 * Commands that may ask a question share the wizard's mapping: a cancelled
 * prompt is not a failure, and a missing terminal is guidance rather than a
 * diagnosis.
 */
async function withPrompts(run: () => Promise<number>): Promise<number> {
  const ui = new Ui();
  try {
    return await run();
  } catch (err) {
    const code = reportPromptError(err, ui);
    if (code === undefined) throw err;
    return code;
  }
}

export async function runJamCommand(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

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
      // login/logout are human-only by design: an agent must stop at
      // JAM_AUTH_REQUIRED and hand the person this command, never run it with a
      // token it was given.
      if (rest[0] === "login") return withPrompts(() => authLoginCommand());
      if (rest[0] === "logout") return withPrompts(async () => authLogoutCommand());
      process.stderr.write("Usage: jam auth login | status [--json] | logout\n");
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
