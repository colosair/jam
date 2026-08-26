#!/usr/bin/env node
/**
 * Does this working tree describe one coherent release?
 *
 * The three packages ship in lockstep at an exact version, and that version is
 * written down in more places than anyone can hold in their head: three
 * manifests, the dependencies between them, the launcher constant that decides
 * which server to run, and every `npx @jam-mcp/...@x.y.z` a reader is told to
 * type. Publishing with one of them stale is not a build failure - it is a
 * teammate's editor launching a version nobody tested together.
 *
 * So the drift is checked by a machine while publishing stays a human decision.
 * This reports; it never edits, and it never publishes.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["launcher", "server", "bootstrap"];
const SPEC = /@jam-mcp\/(launcher|server|bootstrap)@([^\s"'`)\],]+)/g;

const problems = [];
const fail = (where, message) => problems.push({ where, message });

function read(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function manifest(name) {
  return JSON.parse(read(`packages/${name}/package.json`));
}

// 1. One version across the three manifests.
const manifests = Object.fromEntries(PACKAGES.map((name) => [name, manifest(name)]));
const version = manifests.launcher.version;

for (const name of PACKAGES) {
  if (manifests[name].version !== version) {
    fail(`packages/${name}/package.json`, `version ${manifests[name].version}, expected ${version}`);
  }
}

// 2. Dependencies between them are that exact version - never a range.
for (const name of PACKAGES) {
  for (const [dep, range] of Object.entries(manifests[name].dependencies ?? {})) {
    if (!dep.startsWith("@jam-mcp/")) continue;
    if (range !== version) {
      fail(`packages/${name}/package.json`, `${dep} pinned at "${range}", expected "${version}"`);
    }
  }
}

// 3. The constant that actually selects a runtime.
const release = read("packages/launcher/src/release.ts");
const declared = /SERVER_VERSION = "([^"]+)"/.exec(release)?.[1];
if (declared !== version) {
  fail("packages/launcher/src/release.ts", `SERVER_VERSION = "${declared}", expected "${version}"`);
}

// 4. The lockfile, which is what actually links a contributor's node_modules.
//
// It records each workspace package's version and bin map separately from the
// manifest, and `npm install` links from it - so a stale lockfile silently
// recreates whatever bin layout it remembers. That is not hypothetical: the
// rename of the server's bin left `node_modules/.bin/jam` pointing at the
// server on machines that had installed before it.
const lock = JSON.parse(read("package-lock.json"));
for (const name of PACKAGES) {
  const entry = lock.packages?.[`packages/${name}`];
  if (!entry) {
    fail("package-lock.json", `no entry for packages/${name} - run npm install`);
    continue;
  }
  if (entry.version !== version) {
    fail("package-lock.json", `packages/${name} at ${entry.version}, expected ${version} - run npm install`);
  }
  const expected = JSON.stringify(manifests[name].bin ?? {});
  if (JSON.stringify(entry.bin ?? {}) !== expected) {
    fail("package-lock.json", `packages/${name} bin is stale - run npm install`);
  }
}

// 5. Every version a reader is told to type.
//
// Only tracked files: an untracked scratch file is nobody's instruction, and a
// stale tarball under private/ is a build artefact, not a claim.
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((path) => /\.(md|ps1|sh|json|yaml|yml|example)$/.test(path))
  .filter((path) => !path.startsWith("packages/") || !path.includes("/dist/"));

for (const path of tracked) {
  if (path.endsWith("package-lock.json")) continue;
  const text = read(path);
  for (const [spec, , pinned] of text.matchAll(SPEC)) {
    if (pinned === version) continue;
    // `<exact>`, `<version>` and friends are deliberately generic - prose that
    // stays true across releases rather than a version anyone types.
    if (pinned.startsWith("<") && pinned.endsWith(">")) continue;
    // A floating or partial spec is worse than a stale one: it changes under
    // the reader, and npm resolves it to something nobody tested.
    if (/^(latest|next)$/.test(pinned) || /^[\^~]/.test(pinned) || !/^\d+\.\d+\.\d+$/.test(pinned)) {
      fail(path, `${spec} is not an exact version`);
      continue;
    }
    fail(path, `${spec} does not match this release (${version})`);
  }
}

if (problems.length === 0) {
  process.stdout.write(`Release ${version} is consistent across manifests, code and docs.\n`);
  process.exit(0);
}

process.stderr.write(`Release ${version} has ${problems.length} inconsistenc${problems.length === 1 ? "y" : "ies"}:\n\n`);
for (const { where, message } of problems) {
  process.stderr.write(`  ${where}\n    ${message}\n`);
}
process.stderr.write("\nFix these before publishing.\n");
process.exit(1);
