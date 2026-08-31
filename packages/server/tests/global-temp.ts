// Global temp reclamation - the main process deletes what every worker made.
//
// Workers are threads, so a process exit hook registered inside one never
// fires; and a per-file afterAll misses files whose whole suite is skipped
// (measured: the JAM_INTEGRATION-gated file leaked its sandbox every run).
// So ownership goes through a manifest: setup() creates it and hands its
// path to the workers via the environment, tempDir()/track() append every
// created directory, and teardown() - main process, after all workers are
// done - removes exactly what is listed. Nothing else is touched.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MANIFEST_ENV = "JAM_TEST_TEMP_MANIFEST";

let manifestDir: string | undefined;

export function setup(): void {
  manifestDir = mkdtempSync(join(tmpdir(), "jam-temp-manifest-"));
  process.env[MANIFEST_ENV] = join(manifestDir, "owned.txt");
}

export function teardown(): void {
  const manifest = process.env[MANIFEST_ENV];
  if (!manifest) return;
  let listed: string[] = [];
  try {
    listed = readFileSync(manifest, "utf8").split("\n").filter(Boolean);
  } catch {
    listed = []; // no test created a directory
  }
  for (const dir of listed) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      // Windows EBUSY/EPERM: no retry, no silence - say what stayed.
      process.stderr.write(`temp cleanup left ${dir}: ${String((error as Error).message)}\n`);
    }
  }
  if (manifestDir) rmSync(manifestDir, { recursive: true, force: true });
  delete process.env[MANIFEST_ENV];
}
