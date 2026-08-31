// Test-owned temp directories - creation and reclamation in one place.
//
// Every suite run left its sandboxes behind (measured: 223 new directories
// under %TEMP% per run - jam-home-*, jam-plan-*, jam-agent-* and friends,
// thousands accumulated). Directories made here are registered and removed
// when the worker process exits, which covers assertion failures and throws
// too; parallel workers each delete only their own list, and nothing this
// module did not create is ever touched.

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const owned: string[] = [];
let hooked = false;

/** mkdtempSync + ownership registration. Deleted on process exit. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  track(dir);
  return dir;
}

/** Register a directory created elsewhere for reclamation. */
export function track(dir: string): void {
  owned.push(dir);
  // Under vitest the authoritative reclamation is the globalSetup teardown in
  // the main process - workers are threads and their exit hooks never fire,
  // and per-file hooks miss fully-skipped files. The manifest covers those.
  const manifest = process.env["JAM_TEST_TEMP_MANIFEST"];
  if (manifest) {
    try {
      appendFileSync(manifest, `${dir}\n`);
    } catch {
      // fall through to the local hooks below
    }
  }
  if (!hooked) {
    hooked = true;
    process.on("exit", cleanupNow);
  }
}

/**
 * Delete everything registered, now. The exit hook calls this; a test may
 * call it directly to verify the lifecycle. Windows EBUSY/EPERM is neither
 * retried nor hidden - one line says what stayed.
 */
export function cleanupNow(): void {
  while (owned.length > 0) {
    const dir = owned.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      process.stderr.write(`temp cleanup left ${dir}: ${String((error as Error).message)}\n`);
    }
  }
}
