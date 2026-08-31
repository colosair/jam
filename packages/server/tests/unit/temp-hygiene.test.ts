// Temp lifecycle - what a test creates is reclaimed even when it fails.
//
// Not a %TEMP%-wide scan (that reads other programs' files); this verifies
// the ownership lifecycle itself. The authoritative reclamation under vitest
// is the globalSetup teardown in the MAIN process - it runs after the workers
// finish regardless of assertion failures or throws, so proving
// "tempDir registers into the manifest" plus "teardown removes what the
// manifest lists" covers the failure path without spawning a child (which
// would also drag Node-version type-stripping into the picture).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MANIFEST_ENV, teardown } from "../global-temp.js";
import { cleanupNow, tempDir } from "../support/temp.js";

const saved = process.env[MANIFEST_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[MANIFEST_ENV];
  else process.env[MANIFEST_ENV] = saved;
});

describe("temp hygiene - reclamation of test-owned directories", () => {
  it("cleanupNow removes what tempDir created", () => {
    const dir = tempDir("jam-hygiene-");
    expect(existsSync(dir)).toBe(true);
    cleanupNow();
    expect(existsSync(dir)).toBe(false);
  });

  it("tempDir registers into the manifest, and teardown reclaims what it lists", () => {
    const stage = mkdtempSync(join(tmpdir(), "jam-hygiene-stage-"));
    const manifest = join(stage, "owned.txt");
    writeFileSync(manifest, "");
    process.env[MANIFEST_ENV] = manifest;

    const dir = tempDir("jam-hygiene-listed-");
    expect(readFileSync(manifest, "utf8")).toContain(dir);
    expect(existsSync(dir)).toBe(true);

    // teardown runs in the main process after the workers, whatever the tests
    // did - reclaiming the listed directory IS the failure-path guarantee.
    teardown();
    expect(existsSync(dir)).toBe(false);

    cleanupNow(); // drop the local registration so the exit hook has nothing left
    rmSync(stage, { recursive: true, force: true });
  });
});
