#!/usr/bin/env node
/**
 * Build all three packages and pack them into ./private/packs.
 *
 * Packing is the closest we get to publishing without publishing: it applies
 * the `files` allowlist, so anything missing from the tarball shows up here
 * rather than in someone's first install.
 *
 * Output goes to private/ because it is gitignored - build artefacts, not
 * source.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "private", "packs");

const PACKAGES = ["@jam-mcp/launcher", "@jam-mcp/server", "@jam-mcp/bootstrap"];

function run(command, args, cwd = repoRoot) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

process.stdout.write("Building all packages...\n");
run("npm", ["run", "build"]);

for (const name of PACKAGES) {
  process.stdout.write(`\nPacking ${name}\n`);
  run("npm", ["pack", "-w", name, "--pack-destination", outDir]);
}

process.stdout.write("\nTarballs:\n");
for (const file of readdirSync(outDir).sort()) {
  const { size } = statSync(join(outDir, file));
  process.stdout.write(`  ${file}  ${(size / 1024).toFixed(1)} KB\n`);
}
process.stdout.write(`\nWrote ${outDir}\n`);
