import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findConfigPath } from "../config/load-config.js";
import { doctor } from "./doctor.js";

/**
 * `jam setup` is deliberately thin: install, build, then hand over to doctor,
 * which is the thing that actually tells you whether it worked.
 */
export async function setup(cwd: string = process.cwd()): Promise<number> {
  const root = repoRoot(cwd);

  if (!existsSync(join(root, "package.json"))) {
    process.stdout.write(
      "[FAIL] Run `jam setup` from the jira-agent-mcp checkout (no package.json found).\n",
    );
    return 1;
  }

  for (const step of [
    { name: "Install dependencies", args: ["ci"] },
    { name: "Build", args: ["run", "build"] },
  ]) {
    process.stdout.write(`\n> npm ${step.args.join(" ")}\n`);
    const res = spawnSync("npm", step.args, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (res.status !== 0) {
      process.stdout.write(`[FAIL] ${step.name}\n`);
      return res.status ?? 1;
    }
  }

  const configPath = findConfigPath(cwd);
  if (!configPath) {
    process.stdout.write(
      "\n[WARN] No .jira-agent/project.yaml found. JAM will run with default field policy and no project key.\n",
    );
  }

  process.stdout.write("\n> jam doctor\n");
  return doctor();
}

function repoRoot(cwd: string): string {
  return cwd;
}
