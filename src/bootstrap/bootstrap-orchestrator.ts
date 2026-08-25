import { buildDeps, type BuildDepsOptions, type JamDeps } from "../deps.js";
import { runHealthGate, type GateResult } from "./boot-health-gate.js";

export type BootstrapResult = {
  deps: JamDeps;
  gate: GateResult;
};

export type BootstrapForServeOptions = Pick<BuildDepsOptions, "cwd" | "jira" | "credentials">;

/**
 * `jam serve`'s boot path: safe-bootstrap the project config if one doesn't
 * exist yet, then run the local-only "boot" gate. No live Jira call happens
 * here - that keeps every `claude` startup fast even when Jira itself is slow
 * or briefly unreachable.
 */
export async function bootstrapForServe(options: BootstrapForServeOptions = {}): Promise<BootstrapResult> {
  const deps = await buildDeps({ ...options, bootstrap: true });
  const gate = await runHealthGate(deps, "boot");
  return { deps, gate };
}
