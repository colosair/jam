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
 * Credential sources need more than HOME to contain, and they differ:
 *
 *   Windows user env  HKCU\Environment - no env override reaches it. That
 *                     fallback exists precisely so a `setx` works without a new
 *                     shell, so credentials may legitimately resolve here.
 *   macOS Keychain    reached through ~/Library/Keychains, so repointing HOME
 *                     does contain it - measured, not assumed.
 *   Linux libsecret   a D-Bus session service, not a path under HOME, so
 *                     repointing HOME does NOT contain it.
 *   Windows DPAPI     a file under ~/.jam, so HOME does contain it.
 *
 * Rather than depend on which of those happens to be path-based, the sandbox
 * switches the secret store off outright. What it proves either way is that
 * runtime config and project config came from the sandbox and not the host,
 * which is what the checks below assert.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** No command here should take anywhere near this long; a hang is a failure. */
const COMMAND_TIMEOUT_MS = 120_000;

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
    // Set after the JAM_* strip above, or the loop would remove it. Keeps the
    // sandbox off the developer's own secret store and off the network with it,
    // and on Windows off HKCU\Environment - neither of which a repointed HOME
    // isolates, because both are per-user rather than per-HOME.
    JAM_DISABLE_SECRET_STORE: "1",
    JAM_DISABLE_USER_ENV: "1",
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
  const [npmFile, npmArgs] = forShell("npm", ["install", "--no-audit", "--no-fund", ...tarballs]);
  execFileSync(npmFile, npmArgs, {
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
    const [file, rest] = forShell(bin, args);
    const stdout = execFileSync(file, rest, {
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

/**
 * The async twin of `runBin`, for the one sandbox that has to answer HTTP
 * requests while a command is running. `execFileSync` blocks the event loop,
 * so an in-process mock server would never get a turn.
 */
async function runBinAsync(bin, args, { cwd, home, env = {} }) {
  try {
    const [afile, arest] = forShell(bin, args);
    const { stdout } = await execFileAsync(afile, arest, {
      cwd,
      env: isolatedEnv(home, env),
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: COMMAND_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: err.code ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
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
  // other by exact version, and installing from tarballs gives npm nothing to
  // resolve that from. A registry install does this part by itself.
  //
  // `jam-server`, not `jam`: `jam` is the launcher's, so that a global install
  // of it dispatches through the user's runtime choice instead of pinning them
  // to one build. The two names collided once; this is where that showed up.
  const bin = join(
    install(dir, home, [tarball("jam-mcp-launcher"), tarball("jam-mcp-server")]),
    "jam-server",
  );

  const help = runBin(bin, ["help"], { cwd: work, home });
  check("bin runs from the tarball install", help.code === 0, help.stderr.slice(0, 200));
  check("help mentions the three MCP tools path", help.stdout.includes("serve"));

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
  // launcher 는 서버를 정확 핀 의존으로 갖는다. registry 에 아직 없는 버전을
  // 오프라인 스모크가 찾으러 가지 않도록 서버 tarball 을 함께 설치한다 —
  // 검증하는 계약(미설정이면 JAM_RUNTIME_CONFIG_MISSING)은 그대로다.
  const bin = join(install(dir, home, [tarball("jam-mcp-launcher"), tarball("jam-mcp-server")]), "jam-launcher");

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

// ----------------------------------------------- persistent (global install)

process.stdout.write("\n@jam-mcp/launcher + server, installed like `npm install -g`\n");
{
  // 영구 설치 계약: launcher 가 전역에 깔리면 서버가 그 곁에 함께 오고,
  // `jam` 은 config 가 없어도 `runtime` 만은 스스로 답해 첫 설정을 만들 수 있으며,
  // package 모드는 npx 없이 그 서버를 직접 실행한다. npx 가 프로세스를 만들지
  // 못하는 기계(실측된 Windows npm 11.6.2)에서 살아남는 경로가 바로 이것이다.
  const { dir, home, work } = sandbox("persistent");
  const prefix = join(home, ".npm-global");
  mkdirSync(prefix, { recursive: true });
  const [globalNpm, globalNpmArgs] = forShell("npm", [
    "install",
    "-g",
    "--no-audit",
    "--no-fund",
    tarball("jam-mcp-launcher"),
    tarball("jam-mcp-server"),
  ]);
  execFileSync(globalNpm, globalNpmArgs, {
    cwd: dir,
    env: isolatedEnv(home, { npm_config_prefix: prefix }),
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: "pipe",
  });
  const globalBin =
    process.platform === "win32" ? join(prefix, "jam.cmd") : join(prefix, "bin", "jam");

  const fresh = runBin(globalBin, ["runtime", "status", "--json"], { cwd: work, home });
  check("fresh machine: runtime status says not_configured", fresh.code !== 0, fresh.stderr.slice(0, 200));
  const freshPayload = parseJson(fresh.stdout);
  check(
    "and points at the launcher's own remedy, not npx",
    freshPayload?.nextCommand?.includes("runtime use package") === true,
    fresh.stdout.slice(0, 200),
  );

  const use = runBin(globalBin, ["runtime", "use", "package"], { cwd: work, home });
  check("`jam runtime use package` needs no pre-existing config", use.code === 0, use.stderr.slice(0, 200));

  const status = runBin(globalBin, ["runtime", "status", "--json"], { cwd: work, home });
  const payload = parseJson(status.stdout);
  check("status now reports package mode", payload?.mode === "package", status.stdout.slice(0, 200));
  check(
    "and package mode runs the installed server directly, not through npx",
    payload?.executable?.command !== "npx" && /index\.js$/.test(payload?.executable?.args?.[0] ?? ""),
    JSON.stringify(payload?.executable ?? {}),
  );

  // 서버까지 실제로 도는가 — setup plan 은 자격 없이도 JSON 한 덩이를 낸다.
  const plan = runBin(globalBin, ["setup", "plan", "--json"], { cwd: work, home });
  const planned = parseJson(plan.stdout);
  check(
    "a forwarded command reaches the directly-run server and answers JSON",
    planned?.status !== undefined,
    (plan.stdout + plan.stderr).slice(0, 300),
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

// ------------------------------------------ agent bootstrap, end to end

/**
 * The one gate that walks the whole path a coding agent walks: install from
 * the tarballs, bind the project it is standing in, register MCP beside
 * whatever is already registered, stop where a person is required, and finish
 * at a `doctor` that has actually talked to Jira.
 *
 * A zero-base agent session failed at exactly this sequence once - it asked
 * whether to replace an existing Atlassian MCP, asked whether setup needed a
 * Jira issue, and never reached a canonical install. The rules that answer
 * those questions live in prose; this proves the machinery underneath them
 * still does what the prose promises.
 *
 * Jira here is a local http server. It answers only the four endpoints the
 * health gate and project listing reach for, demands the sandbox's own Basic
 * credentials on every one of them, and counts what it was asked - so "ready"
 * has to be the result of real round trips rather than a check that quietly
 * skipped.
 *
 * `--shared` is deliberate. Personal scope registers with whatever host CLIs
 * happen to be on this machine's PATH, which is not a thing a release gate can
 * assert; shared scope writes files into the sandbox, which is. The invariant
 * it does not weaken: nothing here passes `--shared` on JAM's behalf, the test
 * asks for it explicitly.
 */
process.stdout.write("\n@jam-mcp/bootstrap - agent bootstrap end to end\n");
{
  const EMAIL = "smoke@example.com";
  const TOKEN = "smoke-token";
  const EXPECTED_AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`;
  const ISSUE = {
    key: "MOCK-1",
    fields: {
      summary: "Smoke issue",
      status: { name: "To Do" },
      updated: "2026-08-27T00:00:00.000+0000",
      issuelinks: [],
    },
  };

  const hits = new Map();
  let unauthorized = 0;
  let unknownRoutes = [];

  const server = createServer((req, res) => {
    const route = new URL(req.url, "http://127.0.0.1").pathname;
    hits.set(route, (hits.get(route) ?? 0) + 1);

    const send = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(text);
    };

    // Presence of a credential is not proof it reached Jira; this is.
    if (req.headers.authorization !== EXPECTED_AUTH) {
      unauthorized++;
      send(401, { errorMessages: ["unauthenticated"] });
      return;
    }

    switch (route) {
      case "/rest/api/3/project/search":
        return send(200, { isLast: true, values: [{ key: "MOCK", name: "Mock Project" }] });
      case "/rest/api/3/myself":
        return send(200, { accountId: "acc-1", displayName: "Smoke Agent" });
      case "/rest/api/3/search/jql":
        return send(200, { issues: [ISSUE] });
      case "/rest/api/3/issue/bulkfetch":
        req.resume();
        return send(200, { issues: [ISSUE] });
      default:
        unknownRoutes.push(route);
        return send(404, { errorMessages: ["not mocked"] });
    }
  });

  try {
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    const jira = { JIRA_BASE_URL: `http://127.0.0.1:${server.address().port}`, JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: TOKEN };

    const { dir, home, work } = sandbox("agent");
    const bin = join(
      install(dir, home, [
        tarball("jam-mcp-launcher"),
        tarball("jam-mcp-server"),
        tarball("jam-mcp-bootstrap"),
      ]),
      "jam-bootstrap",
    );
    // The project is a git repository, the way a real one is - and it already
    // has an MCP server that is not JAM.
    mkdirSync(join(work, ".git"), { recursive: true });
    writeFileSync(
      join(work, ".mcp.json"),
      JSON.stringify({ mcpServers: { atlassian: { command: "noop-atlassian" } } }, null, 2),
      "utf8",
    );

    // 1. No key anywhere: JAM offers what it can see and refuses to guess.
    const selection = parseJson(
      (await runBinAsync(bin, ["setup", "--agent"], { cwd: work, home, env: jira })).stdout,
    );
    check(
      "asks which Jira project rather than inventing one",
      selection?.code === "JAM_PROJECT_SELECTION_REQUIRED",
      JSON.stringify(selection?.code),
    );
    check(
      "enumerates the projects the credentials can actually see",
      selection?.projects?.some((p) => p.key === "MOCK") === true,
      JSON.stringify(selection?.projects),
    );
    check("changed nothing while it could not decide", selection?.changesApplied === false);

    // 2. Key known, credentials absent: the wiring still happens, and the stop
    //    hands over something a person can act on.
    const auth = parseJson(
      (await runBinAsync(bin, ["setup", "--agent", "--project", "MOCK", "--shared"], { cwd: work, home })).stdout,
    );
    check("stops for authentication", auth?.code === "JAM_AUTH_REQUIRED", JSON.stringify(auth?.code));
    check("offers the person a command, not the agent one", auth?.nextAction?.command === undefined);
    check(
      "the command it offers runs on a machine with nothing installed",
      /^npx --yes @jam-mcp\/\S+@\d+\.\d+\.\d+ auth login$/.test(auth?.nextAction?.userCommand ?? ""),
      JSON.stringify(auth?.nextAction?.userCommand),
    );
    check(
      "names the variables that would do instead",
      JSON.stringify(auth?.nextAction?.env) ===
        JSON.stringify(["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]),
      JSON.stringify(auth?.nextAction?.env),
    );
    check("applied the wiring it could apply first", auth?.changesApplied === true);
    check("bound the project it was standing in", existsSync(join(work, ".jira-agent", "project.yaml")));

    const mcp = JSON.parse(readFileSync(join(work, ".mcp.json"), "utf8"));
    check("registered JAM", typeof mcp.mcpServers?.jam === "object");
    check(
      "left the Atlassian MCP exactly where it was",
      mcp.mcpServers?.atlassian?.command === "noop-atlassian",
      JSON.stringify(mcp.mcpServers?.atlassian),
    );

    // 3. Credentials present, runtime still unchosen: a stop the agent clears
    //    by itself, so it comes with a command rather than a question.
    const runtime = parseJson(
      (await runBinAsync(bin, ["setup", "--agent", "--project", "MOCK", "--shared"], { cwd: work, home, env: jira })).stdout,
    );
    check(
      "stops for the runtime once credentials resolve",
      runtime?.code === "JAM_RUNTIME_CONFIG_MISSING",
      JSON.stringify(runtime?.code),
    );
    check(
      "hands back a runnable command for the step it cannot decide",
      /^npx --yes @jam-mcp\/\S+@\d+\.\d+\.\d+ runtime use package$/.test(runtime?.nextAction?.command ?? ""),
      JSON.stringify(runtime?.nextAction?.command),
    );
    check(
      "re-applies nothing that is already in place",
      runtime?.changesApplied === false,
      JSON.stringify(runtime?.changesApplied),
    );

    // 4. The agent clears it. Same command, run from the install rather than
    //    npx, so the sandbox stays off the network.
    const chose = await runBinAsync(bin, ["runtime", "use", "package"], { cwd: work, home, env: jira });
    check("the runtime step succeeds unattended", chose.code === 0, chose.stderr.slice(0, 200));

    // 5. Nothing left for a person: setup verifies rather than reporting.
    const ready = parseJson(
      (await runBinAsync(bin, ["setup", "--agent", "--project", "MOCK", "--shared"], { cwd: work, home, env: jira })).stdout,
    );
    check("reaches READY", ready?.status === "ready", JSON.stringify(ready?.code ?? ready?.status));
    const named = (part) => ready?.checks?.find((c) => c.name.includes(part));
    check("proved Jira authentication", named("Jira authentication")?.ok === true);
    check("proved a JQL search against the bound project", named("JQL search")?.ok === true);
    check("proved the issue detail endpoint", named("Issue detail")?.ok === true);
    check(
      "no fatal check reported a failure",
      ready?.checks?.every((c) => !c.fatal || c.ok) === true,
      JSON.stringify(ready?.checks?.filter((c) => c.fatal && !c.ok)),
    );

    // 6. And doctor agrees, standing on its own.
    const doc = parseJson((await runBinAsync(bin, ["doctor", "--json"], { cwd: work, home, env: jira })).stdout);
    check("doctor agrees, on its own", doc?.status === "ready", JSON.stringify(doc?.status));

    // 7. Server side: READY was earned by round trips, not skipped checks.
    for (const route of [
      "/rest/api/3/project/search",
      "/rest/api/3/myself",
      "/rest/api/3/search/jql",
      "/rest/api/3/issue/bulkfetch",
    ]) {
      check(`called ${route}`, (hits.get(route) ?? 0) > 0);
    }
    check("asked for nothing this mock does not model", unknownRoutes.length === 0, unknownRoutes.join(", "));
    // Every route above rejects anything but this sandbox's exact Basic
    // credentials, so zero refusals across a run that got answers means each
    // call carried them - and that JAM never tried Jira before it had them.
    check("never reached Jira without credentials", unauthorized === 0, `${unauthorized} refused`);
  } finally {
    await new Promise((ok) => server.close(ok));
  }
}

for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });

process.stdout.write(
  failures === 0 ? "\nAll tarball smoke checks passed.\n" : `\n${failures} check(s) failed.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;

/**
 * npm/npx are .cmd shims on Windows and need a shell - but an args array plus
 * shell:true is DEP0190 (unescaped concatenation). Join here, quoting only
 * whitespace; these are our own dev-script argv, not user input.
 */
function forShell(command, args) {
  if (process.platform !== "win32") return [command, args];
  const line = [command, ...args].map((t) => (/s/.test(t) ? `"${t}"` : t)).join(" ");
  return [line, []];
}
