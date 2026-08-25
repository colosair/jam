import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CompositeCredentialProvider } from "../adapters/credentials/composite.js";
import { decideProjectKey, writeBootstrapConfig } from "../bootstrap/project-config-bootstrapper.js";
import { resolveProjectRoot } from "../bootstrap/project-root-resolver.js";
import { runHealthGate } from "../bootstrap/boot-health-gate.js";
import { mergeMcpConfig } from "../bootstrap/mcp-config-merger.js";
import { ProjectConfigSchema } from "../config/schema.js";
import { toJamError } from "../domain/errors.js";
import { buildDeps } from "../deps.js";

export type SetupOptions = {
  cwd?: string;
  /** `--project KEY` */
  explicitKey?: string;
};

const line = (text: string) => process.stdout.write(`${text}\n`);

/**
 * `jam setup`: the one command a teammate should ever need to run by hand.
 *
 * Inside the jira-agent-mcp checkout it also installs and builds; anywhere
 * else (a project repo like target-project) it goes straight to project wiring:
 * decide the Jira project key from an explicit source, write
 * `.jira-agent/project.yaml`, merge a PATH-based JAM entry into `.mcp.json`,
 * then run the full diagnostic gate.
 */
export async function setup(options: SetupOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();

  if (existsSync(join(cwd, "package.json")) && existsSync(join(cwd, "src", "index.ts"))) {
    const installed = await installAndBuild(cwd);
    if (installed !== 0) return installed;
  }

  const jamOnPath = checkJamOnPath();
  line(jamOnPath ? "[OK]   `jam` is on PATH" : "[WARN] `jam` is not on PATH - run `npm link` (or install it globally) so Claude Code can launch it");

  const { root, hasConfig } = resolveProjectRoot(cwd);

  if (!hasConfig) {
    const decision = decideProjectKey(root, { explicitKey: options.explicitKey });
    if (!decision) {
      return await reportUndecidedProject(root);
    }
    writeBootstrapConfig(root, decision.key);
    line(`[OK]   .jira-agent/project.yaml created - project.key = ${decision.key} (from ${decision.source})`);
  }

  const mcpResult = mergeMcpConfig(root);
  line(
    mcpResult.action === "unchanged"
      ? `[OK]   ${mcpResult.path} already has a jam entry - left unchanged`
      : `[OK]   ${mcpResult.path} - ${mcpResult.action === "created" ? "created" : "added jam entry"}`,
  );

  line("\n> jam doctor\n");

  let deps: Awaited<ReturnType<typeof buildDeps>>;
  try {
    deps = await buildDeps({ cwd: root, bootstrap: false });
  } catch (err) {
    line(`[FAIL] Project config - ${toJamError(err).message}`);
    return 1;
  }

  const gate = await runHealthGate(deps, "full");
  for (const check of gate.checks) {
    line(`${check.ok ? "[OK]  " : "[FAIL]"} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
  }
  return gate.passed ? 0 : 1;
}

async function installAndBuild(root: string): Promise<number> {
  for (const step of [
    { name: "Install dependencies", args: ["ci"] },
    { name: "Build", args: ["run", "build"] },
  ]) {
    line(`\n> npm ${step.args.join(" ")}`);
    const res = spawnSync("npm", step.args, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (res.status !== 0) {
      line(`[FAIL] ${step.name}`);
      return res.status ?? 1;
    }
  }
  return 0;
}

function checkJamOnPath(): boolean {
  const res = spawnSync(process.platform === "win32" ? "where" : "which", ["jam"], {
    stdio: "pipe",
  });
  return res.status === 0;
}

/**
 * No config, and no explicit/env/preset source to safely decide one from.
 * JAM never guesses a Jira project from a repo or folder name - it shows the
 * operator their options and asks them to say which one, once.
 */
async function reportUndecidedProject(root: string): Promise<number> {
  line(`[FAIL] No .jira-agent/project.yaml under ${root}, and no project key could be determined safely.`);

  const credentials = new CompositeCredentialProvider();
  const creds = credentials.describe();
  if (!creds.baseUrl || !creds.email || !creds.hasToken) {
    line("       Credentials are also missing - set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN first, then re-run `jam setup`.");
    return 1;
  }

  try {
    const { JiraCloudReadAdapter } = await import("../adapters/jira-cloud/jira-read.adapter.js");
    const jira = new JiraCloudReadAdapter(credentials, ProjectConfigSchema.parse({}));
    const { projects, truncated } = await jira.listProjects();
    if (projects.length === 0) {
      line("       This Jira account cannot see any projects.");
    } else {
      line("       Projects visible to this account:");
      for (const p of projects) line(`         ${p.key}  ${p.name}`);
      if (truncated) line("         ...(more not shown)");
    }
  } catch (err) {
    line(`       Could not list Jira projects: ${toJamError(err).message}`);
  }

  line("       Re-run: jam setup --project <KEY>");
  return 1;
}
