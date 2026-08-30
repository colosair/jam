import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeHostCommand,
  detectHosts,
  hostRegistration,
  listsJamEntry,
  type HostCommand,
  type HostRunResult,
} from "../../src/bootstrap/host-mcp.js";
import { LAUNCHER_PACKAGE_SPEC } from "../../src/bootstrap/mcp-config-merger.js";
import { applySetupPlan } from "../../src/bootstrap/setup-apply.js";
import { computeSetupPlan } from "../../src/bootstrap/setup-plan.js";
import { detectSetupState } from "../../src/bootstrap/setup-state.js";
import type { CredentialPort } from "../../src/ports/credentials.port.js";

/**
 * Registering JAM with a coding agent runs that agent's own CLI, which is a
 * mutation. These tests hold the line it has to stay behind: detect probes,
 * plan records the argv, and only apply runs anything.
 */

/** Records every command, so a spawn during planning is a failing test. */
function recorder(answers: (cmd: HostCommand) => HostRunResult) {
  const calls: HostCommand[] = [];
  const run = (cmd: HostCommand) => {
    calls.push(cmd);
    return answers(cmd);
  };
  return { run, calls };
}

// Both CLIs exit 0 whether or not a server exists, so these differ by what
// they list, not by status - which is the whole reason detection reads the
// name column.
const available = (): HostRunResult => ({
  status: 0,
  failed: false,
  stdout: ["other  npx  enabled", ""].join("\n"),
});
/** An entry from an older release — present, but running a launcher nobody tested this against. */
const registered = (): HostRunResult => ({
  status: 0,
  failed: false,
  stdout: ["jam  npx --yes @jam-mcp/launcher@1.0.0 serve  enabled", "other  npx", ""].join("\n"),
});
/** An entry that runs what this release registers. */
const current = (): HostRunResult => ({
  status: 0,
  failed: false,
  stdout: [`jam  npx --yes ${LAUNCHER_PACKAGE_SPEC} serve  enabled`, "other  npx", ""].join("\n"),
});
const missing = (): HostRunResult => ({ status: null, failed: true, stdout: "" });

const configuredCredentials: CredentialPort = {
  load: () => ({
    baseUrl: "https://example.atlassian.net",
    email: "user@example.com",
    apiToken: "SECRET",
  }),
  describe: () => ({
    baseUrl: "https://example.atlassian.net",
    email: "user@example.com",
    hasToken: true,
    source: "process",
  }),
};

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fixture(): { root: string; home: string } {
  const root = tmp("jam-host-");
  mkdirSync(join(root, ".git"), { recursive: true });
  const home = tmp("jam-hosthome-");
  mkdirSync(join(home, ".jam"), { recursive: true });
  writeFileSync(join(home, ".jam", "config.yaml"), "version: 1\nruntime:\n  mode: package\n", "utf8");
  return { root, home };
}

function state(home: string, root: string, run: ReturnType<typeof recorder>["run"]) {
  return detectSetupState({
    cwd: root,
    home,
    credentials: configuredCredentials,
    git: () => undefined,
    probeHosts: true,
    runHost: run,
  });
}

describe("detectHosts", () => {
  it("reports a host that answers but has no jam entry", () => {
    const { run, calls } = recorder(available);

    expect(detectHosts(run)).toEqual([
      { id: "claude-code", cliAvailable: true, hasJamEntry: false },
      { id: "codex", cliAvailable: true, hasJamEntry: false },
    ]);
    // Listing only - nothing here may change a host's configuration.
    expect(calls.map((c) => c.args)).toEqual([
      ["mcp", "list"],
      ["mcp", "list"],
    ]);
  });

  it("reports a host that cannot be reached as unavailable, not as empty", () => {
    expect(detectHosts(recorder(missing).run)).toEqual([
      { id: "claude-code", cliAvailable: false, hasJamEntry: false },
      { id: "codex", cliAvailable: false, hasJamEntry: false },
    ]);
  });

  it("recognises a host that already has jam", () => {
    expect(detectHosts(recorder(registered).run).every((h) => h.hasJamEntry)).toBe(true);
  });
});

describe("host registration through plan and apply", () => {
  it("plans the exact argv and spawns nothing while planning", () => {
    const { root, home } = fixture();
    const probe = recorder(available);
    const detected = state(home, root, probe.run);
    const probeCalls = probe.calls.length;

    const plan = computeSetupPlan(detected, { explicitKey: "PROJECT" });

    // Planning added no calls of its own: every probe happened during detect.
    expect(probe.calls.length).toBe(probeCalls);
    expect(plan.changes.filter((c) => c.target === "host-mcp")).toMatchObject([
      { host: "claude-code", command: "claude" },
      { host: "codex", command: "codex" },
    ]);
  });

  it("runs exactly what the plan recorded, and nothing else", () => {
    const { root, home } = fixture();
    const plan = computeSetupPlan(state(home, root, recorder(available).run), {
      explicitKey: "PROJECT",
    });
    const apply = recorder(registered);

    applySetupPlan(plan, { home, runHost: apply.run });

    const planned = plan.changes.filter((c) => c.target === "host-mcp");
    expect(apply.calls).toEqual(
      planned.map((c) => ({ command: c.command, args: c.args })),
    );
    // The launcher entry is what gets registered, at its pinned version.
    expect(JSON.stringify(apply.calls)).toContain(LAUNCHER_PACKAGE_SPEC);
  });

  it("plans nothing for a host whose entry already runs this launcher", () => {
    const { root, home } = fixture();

    const plan = computeSetupPlan(state(home, root, recorder(current).run), {
      explicitKey: "PROJECT",
    });

    expect(plan.changes.some((c) => c.target === "host-mcp")).toBe(false);
  });

  it("repairs an entry pinned to an older launcher, and says what it replaces", () => {
    const { root, home } = fixture();

    const plan = computeSetupPlan(state(home, root, recorder(registered).run), {
      explicitKey: "PROJECT",
    });

    const repairs = plan.changes.filter((c) => c.target === "host-mcp");
    expect(repairs.length).toBeGreaterThan(0);
    expect(repairs[0]).toMatchObject({
      type: "replace",
      reason: "stale-registration",
      previousVersion: "1.0.0",
    });
    // An existing-but-stale entry is not "already configured".
    expect(plan.status).toBe("ready_to_apply");
  });

  it("plans nothing for a host it could not reach, rather than guessing", () => {
    const { root, home } = fixture();

    const plan = computeSetupPlan(state(home, root, recorder(missing).run), {
      explicitKey: "PROJECT",
    });

    expect(plan.changes.some((c) => c.target === "host-mcp")).toBe(false);
  });

  it("fails loudly when a host's own CLI rejects the registration", () => {
    const { root, home } = fixture();
    const plan = computeSetupPlan(state(home, root, recorder(available).run), {
      explicitKey: "PROJECT",
    });

    expect(() =>
      applySetupPlan(plan, { home, runHost: () => ({ status: 2, failed: false, stdout: '' }) }),
    ).toThrowError(/claude-code/);
  });

  it("prints a command a person could actually run", () => {
    const registration = hostRegistration("claude-code")!;
    const text = describeHostCommand(registration);

    expect(text.startsWith("claude mcp add jam -s user -- npx ")).toBe(true);
    // Every token is bare, so nothing here needs quoting through a shell.
    expect(text).not.toContain('"');
  });

  it("reads the name column, not any word that happens to say jam", () => {
    const lookalikes = [
      "jam-tools  npx",
      "other  https://example.com/jam/mcp",
      "  claude.ai Jira: https://mcp.atlassian.com - connected",
    ].join("\n");

    expect(listsJamEntry(lookalikes)).toBe(false);
    expect(listsJamEntry(["jam  npx  enabled", ...lookalikes.split("\n")].join("\n"))).toBe(true);
  });
});

// ── bare `jam` registration (1.4.2) ─────────────────────────────────────────
//
// SSAFESTA 실전에서 잡힌 결함의 회귀 고정: persistent 설치의 정본 등록인 bare
// `jam`이 (a) 영구 STALE 오탐되고 (b) setup repair 가 npx pin 으로 되돌려
// npx 캐시 구조를 재생산했다. staleness 는 라인이 아니라 실행체를 실측한다.

import { SERVER_VERSION } from "@jam-mcp/launcher";
import {
  bareJamVersion,
  isBareJamEntry,
  isEntryStale,
  preferBareRegistration,
} from "../../src/bootstrap/host-mcp.js";

const bareListing = (command = "jam"): HostRunResult => ({
  status: 0,
  failed: false,
  stdout: [`jam: ${command} serve - ✔ Connected`, "other  npx", ""].join("\n"),
});
const runtimeStatus = (version: string): HostRunResult => ({
  status: 0,
  failed: false,
  stdout: JSON.stringify({ status: "configured", mode: "package", version }),
});

describe("bare jam entry — version-aware staleness", () => {
  it("bare 라인을 npx 라인과 구분한다 (경로·확장자 표기 포함)", () => {
    for (const command of ["jam", "/usr/local/bin/jam", "C:\\Users\\x\\jam.cmd", "jam.exe"]) {
      expect(isBareJamEntry(`jam: ${command} serve - ✔ Connected`), command).toBe(true);
    }
    expect(isBareJamEntry(`jam: npx --yes ${LAUNCHER_PACKAGE_SPEC} serve`)).toBe(false);
    expect(isBareJamEntry("jam: node /somewhere/jam-server.js serve")).toBe(false);
  });

  it("global launcher 가 이 릴리스와 같으면 bare 등록은 OK 다", () => {
    const { run } = recorder((cmd) =>
      cmd.command === "jam" ? runtimeStatus(SERVER_VERSION) : bareListing(),
    );
    const hosts = detectHosts(run);
    const claude = hosts.find((h) => h.id === "claude-code")!;
    expect(claude.entryBare).toBe(true);
    expect(claude.entryVersion).toBe(SERVER_VERSION);
    expect(claude.entryStale).toBe(false);
  });

  it("global launcher 가 구버전이면 bare 등록은 STALE 이고 측정된 버전이 남는다", () => {
    const { run } = recorder((cmd) =>
      cmd.command === "jam" ? runtimeStatus("0.0.1-older") : bareListing(),
    );
    const claude = detectHosts(run).find((h) => h.id === "claude-code")!;
    expect(claude.entryStale).toBe(true);
    expect(claude.entryVersion).toBe("0.0.1-older");
  });

  it("jam 이 실행되지 않으면 측정 불가 — 보수적으로 STALE", () => {
    const { run } = recorder((cmd) =>
      cmd.command === "jam" ? { status: null, failed: true, stdout: "" } : bareListing(),
    );
    const claude = detectHosts(run).find((h) => h.id === "claude-code")!;
    expect(claude.entryStale).toBe(true);
    expect(claude.entryVersion).toBeUndefined();
  });

  it("bare 라고 무조건 OK 가 아니다 — isEntryStale 는 측정값 없이는 stale 이다", () => {
    expect(isEntryStale("jam: jam serve")).toBe(true);
    expect(isEntryStale("jam: jam serve", SERVER_VERSION)).toBe(false);
    expect(isEntryStale("jam: jam serve", "0.0.1-older")).toBe(true);
  });

  it("bareJamVersion 은 JSON 이 아니거나 실패하면 undefined", () => {
    expect(bareJamVersion(() => ({ status: 0, failed: false, stdout: "not json" }))).toBeUndefined();
    expect(bareJamVersion(() => ({ status: 1, failed: false, stdout: "{}" }))).toBeUndefined();
  });
});

describe("setup repair — persistent-aware registration", () => {
  it("호환 global launcher 가 있으면 repair 는 bare jam 을 등록한다", () => {
    expect(preferBareRegistration(SERVER_VERSION)).toBe(true);
    const registration = hostRegistration("claude-code", { bare: true })!;
    expect(registration.args.slice(registration.args.indexOf("--"))).toEqual(["--", "jam", "serve"]);
    // npx pin 재생산 금지 — 캐시 구조를 도구가 다시 만들지 않는다.
    expect(registration.args.join(" ")).not.toContain("npx");
  });

  it("global launcher 가 없거나 구버전이면 기존 npx pin fallback 이다", () => {
    expect(preferBareRegistration(undefined)).toBe(false);
    expect(preferBareRegistration("0.0.1-older")).toBe(false);
    const registration = hostRegistration("claude-code", { bare: false })!;
    expect(registration.args.join(" ")).toContain(LAUNCHER_PACKAGE_SPEC);
  });

  it("등록·수리 명령은 host CLI 만 부른다 — ~/.jam 의 config/projects/credential 은 접촉 대상이 아니다", () => {
    for (const id of ["claude-code", "codex"] as const) {
      for (const bare of [true, false]) {
        const cmd = hostRegistration(id, { bare })!;
        expect(["claude", "codex"]).toContain(cmd.command);
        expect(cmd.args.join(" ")).not.toMatch(/\.jam|config\.yaml|projects\.yaml|credential/);
      }
    }
  });
});
