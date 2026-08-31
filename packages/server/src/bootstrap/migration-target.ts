import { spawnSync } from "node:child_process";
import { shellInvocation } from "./shell-command.js";
import { LAUNCHER_PACKAGE_SPEC } from "./mcp-config-merger.js";
import { computeSetupPlan, type PlanOptions, type SetupPlan } from "./setup-plan.js";
import type { SetupState } from "./setup-state.js";

/**
 * Whether the package a migration would point `.mcp.json` at can actually be
 * resolved right now.
 *
 * `--migrate` is the one path that rewrites wiring a teammate already has
 * working. Rewriting it toward something that cannot be fetched turns a working
 * configuration into a broken one, and the failure surfaces much later - as a
 * module-not-found from inside the editor's MCP child process.
 */
export type MigrationTarget = {
  spec: string;
  available: boolean;
  /**
   * `not-found` - the registry answered, and this spec is not there. That may
   * mean unpublished, or simply absent from the registry this user is
   * configured against; the check cannot tell those apart and does not claim to.
   * `unverifiable` - no usable answer at all (offline, proxy, timeout, no npm).
   */
  reason?: "not-found" | "unverifiable";
  detail?: string;
};

/** Result shape of a `spawnSync`-style call, narrowed to what the check reads. */
export type RunResult = {
  status: number | null;
  stderr: string;
  error?: NodeJS.ErrnoException;
};

/** Injected by tests so the suite never shells out or reaches a registry. */
export type RunFn = (command: string, args: string[]) => RunResult;

const PROBE_TIMEOUT_MS = 10_000;

function runNpm(command: string, args: string[]): RunResult {
  // npm on Windows is a shell script, not an executable; shellInvocation
  // joins the validated argv because an args array plus shell:true is DEP0190.
  const invocation = shellInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    shell: invocation.shell,
  });
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * Ask npm whether `spec` resolves, using the user's own npm configuration.
 *
 * `npm view` rather than a direct registry request on purpose: it honours the
 * user's `.npmrc`, scoped auth, proxy and custom registry, so a privately
 * published launcher answers correctly instead of looking missing.
 *
 * Fails closed. Everything that cannot be verified - offline, blocked proxy,
 * npm not on PATH, timeout - would also break `npx --yes <spec> serve` at launch
 * time, so "cannot verify" and "would not work" are the same population.
 *
 * The spec is derived from a release constant, never from user input.
 */
export function checkMigrationTarget(
  spec: string = LAUNCHER_PACKAGE_SPEC,
  run: RunFn = runNpm,
): MigrationTarget {
  const result = run("npm", ["view", spec, "version"]);

  // Checked first: both a failed spawn and a timeout leave `status` null.
  if (result.error) {
    return unverifiable(spec, result.error.code ?? result.error.message);
  }
  if (result.status === 0) {
    return { spec, available: true };
  }
  if (/\bE404\b/.test(result.stderr)) {
    return {
      spec,
      available: false,
      reason: "not-found",
      detail: `npm could not find ${spec} in the configured registry.`,
    };
  }
  return unverifiable(spec, `npm view exited ${result.status ?? "without a status"}`);
}

function unverifiable(spec: string, detail: string): MigrationTarget {
  return {
    spec,
    available: false,
    reason: "unverifiable",
    detail: `Could not verify ${spec}: ${detail}`,
  };
}

/**
 * Plan, probing the migration target only when a destructive replacement is
 * actually pending.
 *
 * The probe is gated on the *plan*, not on the `--migrate` flag. A flag alone
 * would make setup reach the network in cases that never rewrite anything -
 * no `.mcp.json`, no jam entry, already canonical wiring, or a stop earlier in
 * the plan - which would add a network dependency and an offline timeout for
 * nothing.
 *
 * `computeSetupPlan` is pure, so planning twice costs nothing and keeps the
 * probe out of the planner: the first pass answers "is an unverified
 * replacement pending", the second decides with the fact in hand.
 */
export function computeSetupPlanWithPreflight(
  state: SetupState,
  options: PlanOptions = {},
  check: () => MigrationTarget = () => checkMigrationTarget(),
): SetupPlan {
  // An injected target is authoritative - never probe over the caller's answer.
  if (options.migrationTarget) return computeSetupPlan(state, options);

  const planned = computeSetupPlan(state, options);
  if (planned.code !== "JAM_MIGRATION_TARGET_UNAVAILABLE") return planned;

  return computeSetupPlan(state, { ...options, migrationTarget: check() });
}
