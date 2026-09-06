import { LAUNCHER_PACKAGE, SERVER_VERSION } from "@jam-mcp/launcher";
import { spawnSync } from "node:child_process";

import {
  detectHosts,
  hostRegistration,
  hostUnregistration,
  type HostId,
  type HostRunner,
  type HostRunResult,
} from "../bootstrap/host-mcp.js";

/**
 * `jam update` - move this machine to the published release without redoing setup.
 *
 * What actually goes stale here is not a directory. JAM is launched by the
 * host from a registration line, and that line carries an exact pin:
 *
 *   jam: npx --yes @jam-mcp/launcher@1.4.5 serve
 *
 * A newer JAM on the registry changes nothing until that line moves. Right
 * after 1.4.6 was published, this machine measured
 * `registration: HOST_REGISTRATION_STALE (registered 1.4.5)` - the agent was
 * still talking to the previous server. The command that fixed it was
 * `jam setup --agent`, which also binds the project, re-detects credentials
 * and re-plans everything else. Re-running setup is not what "update" means,
 * so this path never calls it.
 *
 * The order is the same one ASC uses, and for the same reason: the new build
 * is proven to answer *before* the registration is pointed at it. Nothing is
 * removed first - a failed update leaves the machine running what it was
 * running.
 */
export type UpdateStep = "install" | "verify-install" | "switch-registration" | "verify-health";

export const UPDATE_ORDER: readonly UpdateStep[] = [
  "install",
  "verify-install",
  "switch-registration",
  "verify-health",
];

export type UpdateState =
  /** Every registration this machine has runs the published release. */
  | "CURRENT"
  | "UPDATE_AVAILABLE"
  /** A registration exists whose version cannot be read - it may run anything. */
  | "BROKEN"
  /** The registry could not be asked. Nothing is claimed about being up to date. */
  | "UNKNOWN";

export type HostPlan = {
  id: HostId;
  from?: string;
  /** A bare `jam serve` entry: the version lives in the global install, not the line. */
  bare: boolean;
  action: "repin" | "none" | "unreadable";
};

export type JamUpdatePlan = {
  state: UpdateState;
  latest?: string;
  running: string;
  hosts: HostPlan[];
  steps: readonly UpdateStep[];
  detail?: string;
};

export type HostFacts = {
  id: HostId;
  cliAvailable: boolean;
  hasJamEntry: boolean;
  entryVersion?: string;
  entryBare?: boolean;
};

/**
 * Decide, from what was measured. Pure - it runs nothing and writes nothing.
 *
 * A host with no `jam` entry is left alone. Registering JAM somewhere it was
 * never registered is adoption, not an update, and `jam setup` is where the
 * person says they want that.
 */
export function planJamUpdate(input: { latest?: string; hosts: HostFacts[] }): JamUpdatePlan {
  const running = SERVER_VERSION;
  const registered = input.hosts.filter((host) => host.cliAvailable && host.hasJamEntry);

  if (!input.latest) {
    return {
      state: "UNKNOWN",
      running,
      hosts: [],
      steps: [],
      detail: "the registry could not be asked - nothing is claimed about being up to date",
    };
  }

  const hosts: HostPlan[] = registered.map((host) => ({
    id: host.id,
    ...(host.entryVersion ? { from: host.entryVersion } : {}),
    bare: host.entryBare === true,
    action:
      host.entryVersion === undefined
        ? ("unreadable" as const)
        : host.entryVersion === input.latest
          ? ("none" as const)
          : ("repin" as const),
  }));

  // An entry whose version cannot be read is not "current" - it is a line
  // running something nobody measured. Say that instead of moving it silently.
  if (hosts.some((host) => host.action === "unreadable")) {
    return {
      state: "BROKEN",
      latest: input.latest,
      running,
      hosts,
      steps: [...UPDATE_ORDER],
      detail: "a registration exists whose version could not be read",
    };
  }

  if (hosts.every((host) => host.action === "none")) {
    return { state: "CURRENT", latest: input.latest, running, hosts, steps: [] };
  }

  return { state: "UPDATE_AVAILABLE", latest: input.latest, running, hosts, steps: [...UPDATE_ORDER] };
}

export function updateLine(plan: JamUpdatePlan): string {
  switch (plan.state) {
    case "CURRENT":
      return `Up to date - JAM ${plan.latest} is registered.`;
    case "UPDATE_AVAILABLE": {
      const moving = plan.hosts.filter((host) => host.action === "repin");
      return `Update available - ${plan.latest}: ${moving
        .map((host) => `${host.id} runs ${host.from}`)
        .join(", ")}`;
    }
    case "BROKEN":
    case "UNKNOWN":
      return `${plan.state}: ${plan.detail ?? "(no detail)"}`;
  }
}

/** A process runner with room for an install. The host runner's 20s is not enough for npm. */
const defaultRunner: HostRunner = ({ command, args }): HostRunResult => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 180_000,
    shell: process.platform === "win32",
  });
  if (result.error) return { status: null, failed: true, stdout: "" };
  return { status: result.status, failed: false, stdout: result.stdout ?? "" };
};

export type UpdateOptions = {
  json?: boolean;
  /** Injected by tests. Nothing here may reach a real host CLI or npm unasked. */
  run?: HostRunner;
  /** Injected by tests so a plan never depends on the registry. */
  latest?: () => string | undefined;
  hosts?: () => HostFacts[];
};

export async function jamUpdateCommand(
  command: string | undefined,
  options: UpdateOptions = {},
): Promise<number> {
  if (command !== undefined && command !== "check" && command !== "plan") {
    process.stderr.write(`Unknown update command: ${command}\nUsage: jam update [check|plan] [--json]\n`);
    return 1;
  }
  const run = options.run ?? defaultRunner;
  const latest = (options.latest ?? (() => registryLatest(run)))();
  const facts = (options.hosts ?? (() => detectHosts(run)))();
  const plan = planJamUpdate({ ...(latest ? { latest } : {}), hosts: facts });

  if (command === "check" || command === "plan") {
    emit(plan, options);
    return 0;
  }
  if (plan.steps.length === 0) {
    emit(plan, options);
    return plan.state === "CURRENT" ? 0 : 1;
  }
  return apply(plan, run, options);
}

function emit(plan: JamUpdatePlan, options: UpdateOptions): void {
  if (options.json) process.stdout.write(`${JSON.stringify({ package: LAUNCHER_PACKAGE, ...plan }, null, 2)}\n`);
  else process.stdout.write(`${updateLine(plan)}\n`);
}

/** What the registry has. undefined when it could not be asked - never a guess. */
function registryLatest(run: HostRunner): string | undefined {
  const result = run({ command: "npm", args: ["view", LAUNCHER_PACKAGE, "version"] });
  if (result.failed || result.status !== 0) return undefined;
  const version = result.stdout.trim();
  return /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
}

/**
 * Does that version actually answer?
 *
 * `runtime status --json` is the cheapest honest question: it resolves the
 * runtime the registered entry would resolve, and needs no bound project. A
 * pin that cannot answer here is one the host would fail to start - which is
 * exactly what must not be registered.
 */
function launcherAnswers(run: HostRunner, version: string, bare: boolean): string | undefined {
  const result = bare
    ? run({ command: "jam", args: ["runtime", "status", "--json"] })
    : run({ command: "npx", args: ["--yes", `${LAUNCHER_PACKAGE}@${version}`, "runtime", "status", "--json"] });
  if (result.failed || result.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

async function apply(plan: JamUpdatePlan, run: HostRunner, options: UpdateOptions): Promise<number> {
  const target = plan.latest!;
  process.stdout.write(`${updateLine(plan)}\n`);
  const moving = plan.hosts.filter((host) => host.action !== "none");

  // A bare entry runs the global executable, so that is what has to move.
  // An npx pin is fetched at launch; verifying it is what "install" means there.
  if (moving.some((host) => host.bare)) {
    const installed = run({ command: "npm", args: ["install", "-g", `${LAUNCHER_PACKAGE}@${target}`] });
    if (installed.failed || installed.status !== 0) {
      process.stderr.write(`install failed: npm install -g ${LAUNCHER_PACKAGE}@${target}\n`);
      // Nothing was re-registered. The machine still runs what it ran.
      return 1;
    }
  }

  for (const host of moving) {
    const answered = launcherAnswers(run, target, host.bare);
    if (answered !== target) {
      process.stderr.write(
        `verify failed: ${target} did not answer as ${target}${answered ? ` (got ${answered})` : ""} - registration left as it is\n`,
      );
      return 1;
    }
  }
  process.stdout.write(`verified: ${LAUNCHER_PACKAGE}@${target} answers\n`);

  for (const host of moving) {
    // `mcp add` over an existing entry changes nothing on Claude Code - it
    // answers "already exists". The removal is what makes the re-pin land.
    if (!host.bare) {
      const remove = hostUnregistration(host.id);
      if (remove) run(remove);
    }
    const register = hostRegistration(host.id, { ...(host.bare ? { bare: true } : { version: target }) });
    if (!register) continue;
    const result = run(register);
    if (result.failed || result.status !== 0) {
      process.stderr.write(`switch failed on ${host.id}\n`);
      return rollback(plan, host, run);
    }
    process.stdout.write(`registered: ${host.id} -> ${target}\n`);
  }

  // Read it back. A registration JAM could not verify is never reported as done.
  const after = (options.hosts ?? (() => detectHosts(run)))();
  const stale = after.filter(
    (host) => moving.some((m) => m.id === host.id) && host.entryVersion !== target,
  );
  if (stale.length > 0) {
    process.stderr.write(`health: ${stale.map((host) => `${host.id} still runs ${host.entryVersion ?? "?"}`).join(", ")}\n`);
    return 1;
  }

  // A registration that points at a build which cannot read Jira is not a
  // finished update. `doctor` is the existing health axis - config, credentials
  // and one live read - so it is asked here rather than reimplemented.
  const health = doctorVerdict(run, target, moving.some((host) => host.bare));
  if (health !== "ready") {
    process.stderr.write(`doctor: ${health} - rolling back\n`);
    const first = moving[0];
    return first ? rollback(plan, first, run) : 1;
  }

  process.stdout.write(`JAM ${target} is registered, doctor ready.\n`);
  return 0;
}

/**
 * What `jam doctor --json` says about the build now registered.
 *
 * Run through the same entry the host would run, so this measures the thing
 * that was just registered rather than the process doing the registering.
 */
function doctorVerdict(run: HostRunner, version: string, bare: boolean): string {
  const result = bare
    ? run({ command: "jam", args: ["doctor", "--json"] })
    : run({ command: "npx", args: ["--yes", `${LAUNCHER_PACKAGE}@${version}`, "doctor", "--json"] });
  if (result.failed) return "could not be run";
  try {
    const parsed = JSON.parse(result.stdout) as { status?: unknown };
    return typeof parsed.status === "string" ? parsed.status : "unreadable";
  } catch {
    return result.status === 0 ? "ready" : "unreadable";
  }
}

/** Put back the pin that was there. Only possible when it was readable. */
function rollback(plan: JamUpdatePlan, host: HostPlan, run: HostRunner): number {
  if (!host.from || host.bare) {
    process.stderr.write(`Nothing to roll back to on ${host.id} - re-register with \`jam setup --agent\`.\n`);
    return 1;
  }
  const remove = hostUnregistration(host.id);
  if (remove) run(remove);
  const back = hostRegistration(host.id, { version: host.from });
  const result = back ? run(back) : undefined;
  if (result && !result.failed && result.status === 0) {
    process.stderr.write(`rolled back - ${host.id} runs ${host.from} again.\n`);
    return 1;
  }
  process.stderr.write(`rollback failed on ${host.id} - re-register with \`jam setup --agent\`.\n`);
  return 1;
}
