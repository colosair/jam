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

/**
 * Strip the blocks a document marks as recorded evidence.
 *
 * `docs/operations/release.md` quotes commands a host actually refused, at the
 * version that was current when it refused them and wrapped the way the agent
 * wrapped them. Those are transcripts, not instructions - re-pinning them to
 * the current release would falsify the record, and the checks below exist to
 * keep instructions true.
 */
function withoutEvidence(text) {
  return text.replace(
    /<!-- release-check: historical-evidence:start -->[\s\S]*?<!-- release-check: historical-evidence:end -->/g,
    "",
  );
}

for (const path of tracked) {
  if (path.endsWith("package-lock.json")) continue;
  const text = withoutEvidence(read(path));
  for (const [spec, , pinned] of text.matchAll(SPEC)) {
    if (pinned === version) continue;
    // `<exact>`, `<version>` and friends are deliberately generic - prose that
    // stays true across releases rather than a version anyone types.
    if (pinned.startsWith("<") && pinned.endsWith(">")) continue;
    // The release workflows' `@$V` (and the pre-dispatch era's `@$TAG`)
    // resolve to the release version at run time - the workflow verifies the
    // value against the manifests before using it. Only those exact
    // variables; an arbitrary `$WORD` still fails below.
    if (pinned === "$TAG" || pinned === "$V") continue;
    // A floating or partial spec is worse than a stale one: it changes under
    // the reader, and npm resolves it to something nobody tested.
    if (/^(latest|next)$/.test(pinned) || /^[\^~]/.test(pinned) || !/^\d+\.\d+\.\d+$/.test(pinned)) {
      fail(path, `${spec} is not an exact version`);
      continue;
    }
    fail(path, `${spec} does not match this release (${version})`);
  }
}

// 6. The smoke gate packs what it tests.
//
// `tarball-smoke.mjs` installs whatever tarball it finds under private/packs.
// Left to itself it will happily certify an artefact from a previous release -
// which is exactly what happened on Windows, where 1.0.0 tarballs made five
// server checks fail against a healthy 1.1.0 tree. So `npm run smoke` has to
// repack first, and `smoke:packed` stays available for re-running the same
// artefacts deliberately.
const rootScripts = JSON.parse(read("package.json")).scripts ?? {};
const smoke = rootScripts.smoke ?? "";
if (!/\bpack:all\b/.test(smoke) || !/\bsmoke:packed\b/.test(smoke)) {
  fail("package.json", '"smoke" must run pack:all before smoke:packed, or it tests stale tarballs');
}
if (!/tarball-smoke\.mjs/.test(rootScripts["smoke:packed"] ?? "")) {
  fail("package.json", '"smoke:packed" must run scripts/tarball-smoke.mjs');
}

// 7. One release gate, shared by a developer and by CI.
//
// `release:verify` is what both run, so dropping a step from it silently
// narrows what CI proves. Static composition only - whether the steps pass is
// the test suite's job, not this script's.
const RELEASE_GATE_STEPS = ["build", "test", "release:check", "smoke"];
const verify = rootScripts["release:verify"] ?? "";
if (!verify) {
  fail("package.json", 'no "release:verify" script - CI and the release procedure both run it');
} else {
  const missing = RELEASE_GATE_STEPS.filter((step) => !verify.includes(`npm run ${step}`));
  if (missing.length > 0) {
    fail("package.json", `"release:verify" no longer runs: ${missing.join(", ")}`);
  }
}

// 8. The one command an agent is told to run, unwrapped.
//
// A host matches a permission rule against the whole command, and a pipe makes
// it a compound one - so `... setup --agent 2>&1 | tail -60` matches no rule
// written for `... setup --agent`. An agent that copies a wrapped example from
// these files loses the fallback before it ever needs it. In 2026-08 one did
// exactly that; the wrapper was not why the host refused, but it would have
// made the documented fix unusable.
const AGENT_DOCS = ["README.md", "AGENTS.md", "CLAUDE.md"];
const CANONICAL = `npx --yes @jam-mcp/bootstrap@${version} setup --agent`;

for (const path of AGENT_DOCS) {
  const lines = withoutEvidence(read(path)).split("\n");
  const mentions = lines.filter((line) => line.includes("setup --agent"));
  if (!mentions.some((line) => line.trim() === CANONICAL)) {
    fail(path, `no line reads exactly \`${CANONICAL}\` - the canonical command has drifted`);
  }
  for (const line of mentions) {
    // Prose may name a wrapped command to forbid it; a fenced command line is
    // an instruction, and instructions carry no shell around them.
    if (!line.startsWith("npx ")) continue;
    const wrapper = /[|>&;]|(^|\s)cd\s/.exec(line);
    if (wrapper) fail(path, `canonical command is wrapped in shell (\`${wrapper[0].trim()}\`): ${line.trim()}`);
  }
}

// 9. AGENTS.md and CLAUDE.md say the same thing about installing JAM.
//
// The two files are one document with two names, and hosts read one or the
// other - so a rule added to one and not the other is a rule half the agents
// never see. That has happened: the operation count sat at "three" in AGENTS.md
// for two releases while CLAUDE.md said five.
//
// This pins the mirror, and nothing else. Whether either file agrees with the
// code is a different question and not one this check answers.
const MIRROR_HEADING = "## Installing JAM into another project";
const mirrored = (path) => {
  const text = read(path);
  const start = text.indexOf(MIRROR_HEADING);
  if (start < 0) {
    fail(path, `no "${MIRROR_HEADING}" section - the agent install rules live there`);
    return undefined;
  }
  const rest = text.slice(start + MIRROR_HEADING.length);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
};
const agentsBlock = mirrored("AGENTS.md");
const claudeBlock = mirrored("CLAUDE.md");
if (agentsBlock !== undefined && claudeBlock !== undefined && agentsBlock !== claudeBlock) {
  fail("AGENTS.md", `"${MIRROR_HEADING}" no longer matches CLAUDE.md word for word`);
}

// 7. The write surface named identically everywhere agents read.
//
// The operation count drifted once (three in AGENTS.md, five in CLAUDE.md, two
// releases apart). Pin the five names and the count phrase in every agent doc.
const WRITE_OPS = ["comment.add", "field.update", "status.transition", "assignee.update", "issue.create"];
for (const path of AGENT_DOCS) {
  const text = read(path);
  for (const op of WRITE_OPS) {
    if (!text.includes(op)) fail(path, `write operation ${op} is not named - the write surface has drifted`);
  }
  if (!text.includes("Five operations")) fail(path, 'the write surface is not stated as "Five operations"');
}

// 8. CLAUDE.md is AGENTS.md plus host-specific detail, never minus a section.
const agentHeadings = [...read("AGENTS.md").matchAll(/^## .+$/gm)].map((m) => m[0]);
const claudeText = read("CLAUDE.md");
for (const heading of agentHeadings) {
  if (!claudeText.includes(heading)) fail("CLAUDE.md", `missing section from AGENTS.md: "${heading}"`);
}

// 9. The Release body is authored, not generated.
//
// release-finalize.yml creates the GitHub Release from docs/releases/v<version>.md.
// A missing or unstructured note fails here first, so the release-prep PR carries
// it rather than someone writing it into a web form later.
const notePath = `docs/releases/v${version}.md`;
let note = null;
try {
  note = read(notePath);
} catch {
  note = null;
}
if (note === null) {
  fail(notePath, "missing - the Release body is authored, not generated");
} else {
  for (const section of [
    "## What changed",
    "## Install / Upgrade",
    "## Agent setup",
    "## Compatibility",
    "## Verified",
    "## Known limitations",
  ]) {
    if (!note.includes(section)) fail(notePath, `lacks required section: ${section}`);
  }
  if (!note.includes(version)) fail(notePath, `never names ${version}`);
  if (/[가-힣]/.test(note)) fail(notePath, "public release artefacts are English (Hangul found)");
  if (!note.includes(`@jam-mcp/bootstrap@${version}`)) fail(notePath, "does not pin the bootstrap install command");
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
