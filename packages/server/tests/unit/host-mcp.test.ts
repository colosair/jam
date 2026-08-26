import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeHostCommand,
  detectHosts,
  hostRegistration,
  type HostCommand,
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
function recorder(answers: (cmd: HostCommand) => { status: number | null; failed: boolean }) {
  const calls: HostCommand[] = [];
  const run = (cmd: HostCommand) => {
    calls.push(cmd);
    return answers(cmd);
  };
  return { run, calls };
}

const available = () => ({ status: 1, failed: false }); // present, no jam entry
const registered = () => ({ status: 0, failed: false });
const missing = () => ({ status: null, failed: true });

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
    // `get` only - nothing here may change a host's configuration.
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["mcp", "get"],
      ["mcp", "get"],
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

  it("plans nothing for a host that already has jam", () => {
    const { root, home } = fixture();

    const plan = computeSetupPlan(state(home, root, recorder(registered).run), {
      explicitKey: "PROJECT",
    });

    expect(plan.changes.some((c) => c.target === "host-mcp")).toBe(false);
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
      applySetupPlan(plan, { home, runHost: () => ({ status: 2, failed: false }) }),
    ).toThrowError(/claude-code/);
  });

  it("prints a command a person could actually run", () => {
    const registration = hostRegistration("claude-code")!;
    const text = describeHostCommand(registration);

    expect(text.startsWith("claude mcp add-json jam ")).toBe(true);
    expect(text).toContain("-s user");
  });
});
