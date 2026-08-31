// Temp lifecycle - what a test creates is reclaimed even when it fails.
// Not a %TEMP%-wide scan (that reads other programs' files); this verifies
// the ownership lifecycle of tempDir itself, including the exit path of a
// worker that died on an assertion.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupNow, tempDir } from "../support/temp.js";

const posix = (p: string) => p.split("\\").join("/");

describe("temp hygiene - reclamation of test-owned directories", () => {
  it("cleanupNow removes what tempDir created", () => {
    const dir = tempDir("jam-hygiene-");
    expect(existsSync(dir)).toBe(true);
    cleanupNow();
    expect(existsSync(dir)).toBe(false);
  });

  it("a child process that throws still reclaims on exit", () => {
    const stage = mkdtempSync(join(tmpdir(), "jam-hygiene-stage-"));
    const marker = posix(join(stage, "made.txt"));
    const helper = "file:///" + posix(join(import.meta.dirname, "..", "support", "temp.ts"));
    const script = join(stage, "failing.mjs");
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs'",
      "import { tempDir } from '" + helper + "'",
      "const dir = tempDir('jam-hygiene-child-')",
      "writeFileSync('" + marker + "', dir)",
      "throw new Error('deliberate failure')",
    ].join("\n"));
    const env = { ...process.env };
    delete env["NODE_TEST_CONTEXT"];
    const run = spawnSync(process.execPath, [script], { encoding: "utf8", env });
    expect(run.status).not.toBe(0);
    const childDir = readFileSync(marker, "utf8").trim();
    expect(existsSync(childDir)).toBe(false);
    rmSync(stage, { recursive: true, force: true });
  });
});
