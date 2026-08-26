import { buildDeps, type BuildDepsOptions, type JamDeps } from "../deps.js";
import { runHealthGate, type GateResult } from "./boot-health-gate.js";

export type BootstrapResult = {
  deps: JamDeps;
  gate: GateResult;
};

export type BootstrapForServeOptions = Pick<
  BuildDepsOptions,
  "cwd" | "jira" | "credentials" | "env" | "presetsPath" | "home" | "git"
>;

/**
 * `jam serve`'s boot path: resolve the project config - reading a file if the
 * project has one, otherwise falling back to an explicitly supplied key - then
 * run the local-only "boot" gate. Nothing here writes to the repository, and
 * no live Jira call happens either, so every `claude` startup stays fast even
 * when Jira is slow or briefly unreachable.
 */
export async function bootstrapForServe(options: BootstrapForServeOptions = {}): Promise<BootstrapResult> {
  const deps = await buildDeps({ ...options, keyFallback: "required" });
  const gate = await runHealthGate(deps, "boot");
  return { deps, gate };
}
