import { LAUNCHER_PACKAGE, SERVER_VERSION } from "@jam-mcp/launcher";
import { spawnSync } from "node:child_process";

import { doctorJsonCommand } from "./agent-api.js";
import { doctor } from "./doctor.js";
import {
  detectHosts,
  hostRegistration,
  hostUnregistration,
  type HostId,
  type HostRunner,
  type HostRunResult,
  type HostState,
} from "../bootstrap/host-mcp.js";

/**
 * The lifecycle words JAM shares with ASC: `refresh` and `uninstall`.
 *
 * The two products answer to the same vocabulary because a person should not
 * have to remember which one uses which verb:
 *
 *   setup      make it usable for the first time
 *   status     what is configured, what works, what is blocked
 *   update     move to a newer published release
 *   refresh    keep the version, re-converge what this build registered
 *   uninstall  remove the product; the person's state stays
 *   runtime    which build this machine actually runs
 *
 * What is different is ownership, and that stays different. JAM is the Jira
 * access layer: it has no execution mode, no approval path and no session
 * model. A Jira write still travels ASC's decision path and lands through
 * JAM's own write plan/apply - this file does not change that.
 */

/** A runner with room for npm. The host runner's 20s is not enough for an install. */
const defaultRunner: HostRunner = ({ command, args }): HostRunResult => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 180_000,
    shell: process.platform === "win32",
  });
  if (result.error) return { status: null, failed: true, stdout: "" };
  return { status: result.status, failed: false, stdout: result.stdout ?? "" };
};

export type LifecycleOptions = {
  json?: boolean;
  /** Injected by tests. Nothing here may reach a real host CLI or npm unasked. */
  run?: HostRunner;
  hosts?: () => HostState[];
};

export type RefreshHostPlan = {
  id: HostId;
  from?: string;
  bare: boolean;
  action: "repin" | "none";
};

export type RefreshPlan = {
  /** The version this build is. `refresh` never moves off it - that is `update`. */
  version: string;
  hosts: RefreshHostPlan[];
  steps: readonly string[];
};

/**
 * What `refresh` would converge. Pure: it runs nothing and writes nothing.
 *
 * The scope is deliberately small. A registration that points at a different
 * launcher than this build is what goes stale here. The project binding, the
 * credentials, `~/.jam/config.yaml` and every byte of Jira data are outside
 * it - re-deciding those is `setup`, and calling it "refresh" is how a person
 * loses a binding they never asked to change.
 */
export function planRefresh(hosts: readonly HostState[], version = SERVER_VERSION): RefreshPlan {
  const registered = hosts.filter((host) => host.cliAvailable && host.hasJamEntry);
  const plans: RefreshHostPlan[] = registered.map((host) => ({
    id: host.id,
    ...(host.entryVersion ? { from: host.entryVersion } : {}),
    bare: host.entryBare === true,
    // A bare entry runs the global executable, so its line is already whatever
    // that executable is. Only a pinned line can point somewhere else.
    action: host.entryBare === true || host.entryVersion === version ? "none" : "repin",
  }));
  const moving = plans.filter((host) => host.action === "repin");
  return {
    version,
    hosts: plans,
    steps: moving.length === 0 ? [] : ["switch-registration", "verify"],
  };
}

export function refreshLine(plan: RefreshPlan): string {
  const moving = plan.hosts.filter((host) => host.action === "repin");
  if (plan.hosts.length === 0) return "No host has a JAM registration - `jam setup` is what adds one.";
  return moving.length === 0
    ? `Registration is current - JAM ${plan.version}. Version unchanged.`
    : `Would re-register: ${moving.map((host) => `${host.id} runs ${host.from ?? "?"}`).join(", ")}`;
}

/**
 * `jam refresh` - keep the version, make the registration match it again.
 *
 * Nothing is removed before the replacement is known to work, which is the
 * same order `update` uses and for the same reason: a failed refresh leaves
 * the machine running what it was running.
 */
export async function jamRefreshCommand(
  command: string | undefined,
  options: LifecycleOptions = {},
): Promise<number> {
  if (command !== undefined && command !== "check" && command !== "plan") {
    process.stderr.write(`Unknown refresh command: ${command}\nUsage: jam refresh [check|plan] [--json]\n`);
    return 1;
  }
  const run = options.run ?? defaultRunner;
  const hosts = (options.hosts ?? (() => detectHosts(run)))();
  const plan = planRefresh(hosts);

  if (command === "check" || command === "plan") {
    if (options.json) process.stdout.write(`${JSON.stringify({ package: LAUNCHER_PACKAGE, ...plan }, null, 2)}\n`);
    else process.stdout.write(`${refreshLine(plan)}\n`);
    return 0;
  }

  if (plan.steps.length === 0) {
    if (options.json) process.stdout.write(`${JSON.stringify({ package: LAUNCHER_PACKAGE, ...plan, changed: [] }, null, 2)}\n`);
    else process.stdout.write(`${refreshLine(plan)}\n`);
    return 0;
  }

  const changed: HostId[] = [];
  for (const host of plan.hosts.filter((h) => h.action === "repin")) {
    // `mcp add` over an existing entry changes nothing on Claude Code - it
    // answers "already exists". The removal is what makes the re-pin land.
    const remove = hostUnregistration(host.id);
    if (remove) run(remove);
    const register = hostRegistration(host.id, { version: plan.version });
    if (!register) continue;
    const result = run(register);
    if (result.failed || result.status !== 0) {
      process.stderr.write(`refresh failed on ${host.id} - re-register with \`jam setup --agent\`.\n`);
      return 1;
    }
    changed.push(host.id);
  }

  // Read it back. A registration JAM could not verify is never reported as done.
  const after = (options.hosts ?? (() => detectHosts(run)))();
  const stale = after.filter(
    (host) => changed.includes(host.id) && host.entryBare !== true && host.entryVersion !== plan.version,
  );
  if (stale.length > 0) {
    process.stderr.write(
      `health: ${stale.map((host) => `${host.id} still runs ${host.entryVersion ?? "?"}`).join(", ")}\n`,
    );
    return 1;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ package: LAUNCHER_PACKAGE, ...plan, changed }, null, 2)}\n`);
  } else {
    for (const id of changed) process.stdout.write(`registered: ${id} -> ${plan.version}\n`);
    process.stdout.write(`JAM ${plan.version} is registered. Version unchanged.\n`);
  }
  return 0;
}

export type UninstallPlan = {
  /** Registrations that would be removed. */
  hosts: HostId[];
  /** Whether a global launcher install would be removed with it. */
  runtime: string | null;
  preserve: string[];
};

/**
 * `jam uninstall` - remove what JAM installed, keep what is the person's.
 *
 * Removed: the MCP registrations JAM wrote, and the global launcher when one
 * is installed. Kept: `~/.jam` in full - the project bindings, the runtime
 * choice and the credentials in the OS secret store. There is no purge here
 * on purpose: nothing yet needs a command that destroys those, and an
 * irreversible one that nobody asked for is worse than a missing one.
 */
export function planUninstall(hosts: readonly HostState[], installed: string | null): UninstallPlan {
  return {
    hosts: hosts.filter((host) => host.cliAvailable && host.hasJamEntry).map((host) => host.id),
    runtime: installed,
    preserve: [
      "~/.jam/projects.yaml - which project each checkout is bound to",
      "~/.jam/config.yaml - the runtime this machine chose",
      "Jira credentials in the OS secret store",
      "every .jira-agent/project.yaml a repository carries",
    ],
  };
}

export async function jamUninstallCommand(
  command: string | undefined,
  options: LifecycleOptions = {},
): Promise<number> {
  if (command !== undefined && command !== "plan") {
    process.stderr.write(`Unknown uninstall command: ${command}\nUsage: jam uninstall [plan] [--json]\n`);
    return 1;
  }
  const run = options.run ?? defaultRunner;
  const hosts = (options.hosts ?? (() => detectHosts(run)))();
  const installed = globalLauncher(run);
  const plan = planUninstall(hosts, installed);

  if (command === "plan") {
    if (options.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    else {
      process.stdout.write(
        plan.hosts.length === 0
          ? "No host registration to remove.\n"
          : `Would remove the JAM registration from: ${plan.hosts.join(", ")}\n`,
      );
      if (plan.runtime) process.stdout.write(`Would remove ${LAUNCHER_PACKAGE}@${plan.runtime}\n`);
      for (const kept of plan.preserve) process.stdout.write(`Would keep: ${kept}\n`);
    }
    return 0;
  }

  let worst = 0;
  for (const id of plan.hosts) {
    const remove = hostUnregistration(id);
    if (!remove) continue;
    const result = run(remove);
    if (result.failed || result.status !== 0) {
      process.stderr.write(`could not remove the registration from ${id}\n`);
      worst = 1;
      continue;
    }
    process.stdout.write(`removed: ${id} registration\n`);
  }

  if (plan.runtime) {
    const removal = run({ command: "npm", args: ["uninstall", "-g", LAUNCHER_PACKAGE] });
    if (removal.failed || removal.status !== 0) {
      process.stderr.write(`could not remove ${LAUNCHER_PACKAGE} - run: npm uninstall -g ${LAUNCHER_PACKAGE}\n`);
      worst = 1;
    } else {
      process.stdout.write(`removed: ${LAUNCHER_PACKAGE}@${plan.runtime}\n`);
    }
  }

  process.stdout.write("\nYour state stays:\n");
  for (const kept of plan.preserve) process.stdout.write(`  ${kept}\n`);
  return worst;
}

/** The globally installed launcher version, or null when there is none. */
function globalLauncher(run: HostRunner): string | null {
  const result = run({ command: "npm", args: ["ls", "-g", "--depth=0", "--json", LAUNCHER_PACKAGE] });
  if (result.failed) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { dependencies?: Record<string, { version?: string }> };
    return parsed.dependencies?.[LAUNCHER_PACKAGE]?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * `jam status` - the first place a person asks what is going on.
 *
 * This is `doctor`'s user-facing role under the name both products use. The
 * judgement is not reimplemented: the same health gate and the same per-axis
 * verdicts answer here, so the two commands can never disagree.
 */
export async function jamStatusCommand(options: { json?: boolean } = {}): Promise<number> {
  if (options.json) return doctorJsonCommand();

  process.stdout.write(`jam ${SERVER_VERSION}\n`);
  const code = await doctor();
  process.stdout.write(
    code === 0
      ? "\nNext: nothing - reading Jira is ready. `jam update` when a newer release is out.\n"
      : "\nNext: `jam setup` binds this project and stores what is missing. `jam refresh` only re-registers.\n",
  );
  return code;
}
