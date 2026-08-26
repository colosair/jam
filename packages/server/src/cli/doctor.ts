import { buildDeps } from "../deps.js";
import { toJamError } from "../domain/errors.js";
import { runHealthGate } from "../bootstrap/boot-health-gate.js";

/**
 * `jam doctor` exists to answer one question fast: is this a Jira problem, a
 * credential problem, or a local setup problem? It is read-only - it never
 * bootstraps a missing project.yaml (that is `jam setup`'s job) - and runs the
 * "full" health gate, including live Jira connectivity.
 */
export async function doctor(cwd?: string): Promise<number> {
  let deps: Awaited<ReturnType<typeof buildDeps>>;
  try {
    // Optional fallback: doctor reports what `jam serve` would run with -
    // including a key that comes from this user's binding rather than from a
    // file in the repository - and never refuses to load.
    deps = await buildDeps({ cwd, keyFallback: "optional" });
  } catch (err) {
    process.stdout.write(`[FAIL] Project config - ${toJamError(err).message}\n`);
    return 1;
  }

  const gate = await runHealthGate(deps, "full");
  for (const check of gate.checks) {
    process.stdout.write(
      `${check.ok ? "[OK]  " : "[FAIL]"} ${check.name}${check.detail ? ` - ${check.detail}` : ""}\n`,
    );
  }

  const failed = gate.checks.filter((c) => !c.ok);
  process.stdout.write(
    failed.length === 0
      ? `\nAll ${gate.checks.length} checks passed.\n`
      : `\n${failed.length} of ${gate.checks.length} checks failed: ${failed.map((f) => f.name).join(", ")}\n`,
  );
  return gate.passed ? 0 : 1;
}
