#!/usr/bin/env node
/**
 * Install the packed tarballs into a throwaway environment and check they
 * actually run.
 *
 * The isolation is the whole point. This machine has a real ~/.jam, real Jira
 * credentials in its user environment, and a real project config - any of
 * which would let a broken package look fine. So every run gets:
 *
 *   HOME / USERPROFILE  -> a temp directory (no ~/.jam, no presets)
 *   cwd                 -> a temp directory (no project config)
 *   JIRA_* / JAM_*      -> stripped from the environment
 *   npm_config_cache    -> a temp directory
 *
 * PATH is left intact because npm and node have to be findable, but nothing
 * here invokes a bare `jam`: every command runs the binary from inside the
 * tarball install, so a globally linked JAM cannot stand in for it.
 *
 * One thing this deliberately cannot isolate: on Windows JAM falls back to the
 * *user* environment in the registry (HKCU\Environment), which no env override
 * reaches - that fallback exists precisely so a `setx` works without a new
 * shell. So credentials may legitimately resolve inside a sandbox here. What
 * the sandbox does prove is that runtime config and project config came from
 * the sandbox and not from the host, which is what the checks below assert.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packDir = join(repoRoot, "private", "packs");

let failures = 0;
const cleanups = [];

function isolatedEnv(home, extra = {}) {
  const env = { ...process.env };
  // Anything that could make a broken package look configured.
  for (const key of Object.keys(env)) {
    if (key.startsWith("JIRA_") || key.startsWith("JAM_")) delete env[key];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: join(home, ".npm-cache"),
    NO_COLOR: "1",
    ...extra,
  };
}

function tarball(prefix) {
  const file = readdirSync(packDir).find((f) => f.startsWith(prefix) && f.endsWith(".tgz"));
  if (!file) throw new Error(`No tarball for ${prefix} in ${packDir}. Run: npm run pack:all`);
  return join(packDir, file);
}

function sandbox(name) {
  const dir = mkdtempSync(join(tmpdir(), `jam-smoke-${name}-`));
  const home = join(dir, "home");
  const work = join(dir, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  cleanups.push(dir);
  return { dir, home, work };
}

/** Install tarballs into an isolated prefix. Returns the node_modules/.bin path. */
function install(dir, home, tarballs) {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "smoke", private: true }), "utf8");
  execFileSync("npm", ["install", "--no-audit", "--no-fund", ...tarballs], {
    cwd: dir,
    env: isolatedEnv(home),
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: "pipe",
  });
  return join(dir, "node_modules", ".bin");
}

function runBin(bin, args, { cwd, home, env = {} }) {
  try {
    const stdout = execFileSync(bin, args, {
      cwd,
      env: isolatedEnv(home, env),
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: "pipe",
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

function check(label, condition, detail = "") {
  if (condition) {
    process.stdout.write(`  [OK]   ${label}\n`);
  } else {
    failures++;
    process.stdout.write(`  [FAIL] ${label}${detail ? ` - ${detail}` : ""}\n`);
  }
}

// ---------------------------------------------------------------- server

process.stdout.write("\n@jam-mcp/server\n");
{
  const { dir, home, work } = sandbox("server");
  // The launcher tarball goes in alongside it: these packages depend on each
  // other by exact version, and nothing is on the registry yet to resolve
  // that from. Post-publish npm does this part.
  const bin = join(
    install(dir, home, [tarball("jam-mcp-launcher"), tarball("jam-mcp-server")]),
    "jam",
  );

  const help = runBin(bin, ["help"], { cwd: work, home });
  check("bin runs from the tarball install", help.code === 0, help.stderr.slice(0, 200));
  check("help mentions the three MCP tools path", help.stdout.includes("jam serve"));

  // No project config and no credentials in this sandbox, so doctor must fail
  // for those reasons - proving it read the sandbox and not the real machine.
  const doc = runBin(bin, ["doctor"], { cwd: work, home });
  check("doctor exits non-zero without configuration", doc.code !== 0);
  check(
    "doctor read the sandbox's project state, not the host's",
    /no \.jira-agent[\/]project\.yaml found/.test(doc.stdout) &&
      /Jira project key - not set/.test(doc.stdout),
    doc.stdout.slice(0, 300),
  );

  const planned = runBin(bin, ["setup", "plan", "--json"], { cwd: work, home });
  let parsed;
  try {
    parsed = JSON.parse(planned.stdout);
  } catch {
    parsed = undefined;
  }
  check("setup plan --json emits parseable JSON", parsed !== undefined, planned.stdout.slice(0, 200));
  check(
    "and refuses to guess a project key",
    parsed?.code === "JAM_PROJECT_SELECTION_REQUIRED",
    JSON.stringify(parsed?.code),
  );
}

// -------------------------------------------------------------- launcher

process.stdout.write("\n@jam-mcp/launcher\n");
{
  const { dir, home, work } = sandbox("launcher");
  const bin = join(install(dir, home, [tarball("jam-mcp-launcher")]), "jam-launcher");

  const unconfigured = runBin(bin, ["serve"], { cwd: work, home });
  check("exits non-zero with no runtime configured", unconfigured.code !== 0);
  check(
    "names the missing-config code on stderr",
    unconfigured.stderr.includes("JAM_RUNTIME_CONFIG_MISSING"),
    unconfigured.stderr.slice(0, 200),
  );
  check("writes nothing to stdout (it belongs to MCP)", unconfigured.stdout === "");

  // Point it at this repo as a development runtime and confirm it dispatches
  // through to the real server.
  mkdirSync(join(home, ".jam"), { recursive: true });
  writeFileSync(
    join(home, ".jam", "config.yaml"),
    `version: 1\nruntime:\n  mode: development\n  source: ${JSON.stringify(repoRoot)}\n`,
    "utf8",
  );

  // `help` is answered by the launcher itself, so it proves nothing about
  // dispatch. `doctor` is forwarded, and its output can only come from the
  // server the launcher started.
  const dispatched = runBin(bin, ["doctor"], { cwd: work, home });
  const dispatchedOutput = dispatched.stdout + dispatched.stderr;
  check(
    "forwards a command through to the configured development runtime",
    /Node runtime/.test(dispatchedOutput),
    dispatchedOutput.slice(0, 300),
  );
  check(
    "and the child, not the launcher, decided the exit code",
    dispatched.code !== 0,
    `exit ${dispatched.code}`,
  );
}

// ------------------------------------------------------------- bootstrap

process.stdout.write("\n@jam-mcp/bootstrap\n");
{
  const { dir, home, work } = sandbox("bootstrap");
  const bin = join(
    install(dir, home, [
      tarball("jam-mcp-launcher"),
      tarball("jam-mcp-server"),
      tarball("jam-mcp-bootstrap"),
    ]),
    "jam-bootstrap",
  );

  const help = runBin(bin, ["--help"], { cwd: work, home });
  check("bin runs from the tarball install", help.code === 0, help.stderr.slice(0, 200));
  check("documents both the human and agent entry points", help.stdout.includes("setup --agent"));

  const agent = runBin(bin, ["setup", "--agent"], { cwd: work, home });
  let parsed;
  try {
    parsed = JSON.parse(agent.stdout);
  } catch {
    parsed = undefined;
  }
  check("forwards setup --agent and returns JSON", parsed !== undefined, agent.stdout.slice(0, 200));
  check(
    "stops for a human rather than guessing",
    parsed?.requiresUserAction === true,
    JSON.stringify(parsed?.code),
  );
  check("applied nothing it could not decide", parsed?.changesApplied === false);
}

for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });

process.stdout.write(
  failures === 0 ? "\nAll tarball smoke checks passed.\n" : `\n${failures} check(s) failed.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
