import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authStatusCommand,
  setupApplyCommand,
  setupPlanCommand,
} from "../../src/cli/agent-api.js";
import type { CredentialPort } from "../../src/ports/credentials.port.js";
import { FakeCredentials } from "../helpers.js";

/**
 * Credentials are always injected here, never inherited.
 *
 * These commands otherwise fall through to CompositeCredentialProvider, which
 * reads the machine's JIRA_* env - so the suite would pass on a developer
 * laptop that happens to be authenticated and fail on a fresh one. The
 * no-credential cases additionally keep listVisibleProjects from reaching the
 * network.
 */
const noCredentials: CredentialPort = {
  load: () => {
    throw new Error("no credentials");
  },
  describe: () => ({ hasToken: false, source: "none" }),
};

/**
 * Every environment input a plan can read, pinned - JIRA_*, JAM_PROJECT_KEY,
 * the workspace remote, and the host CLIs. `noHosts` is what keeps a test run
 * from registering JAM with the developer's own Claude Code or Codex.
 */
const noHosts = () => ({ status: null, failed: true, stdout: '' });
const pinned = { env: {}, git: () => undefined, runHost: noHosts };
const authenticated = () => ({ credentials: new FakeCredentials(), ...pinned });
const unauthenticated = () => ({ credentials: noCredentials, ...pinned });

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function project(): string {
  const root = tmp("jam-agent-");
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

/** A home with a runtime chosen, so runtime is never the blocking step. */
function homeWithRuntime(): string {
  const home = tmp("jam-home-");
  mkdirSync(join(home, ".jam"), { recursive: true });
  writeFileSync(join(home, ".jam", "config.yaml"), "version: 1\nruntime:\n  mode: package\n", "utf8");
  return home;
}

/**
 * Capture everything the command writes to stdout. The contract is that this
 * is parseable JSON on its own - so the test parses exactly what an agent
 * would receive, with nothing filtered out first.
 */
async function capture(run: () => Promise<number> | number): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

  try {
    const code = await run();
    return { code, out: chunks.join("") };
  } finally {
    spy.mockRestore();
  }
}

const ANSI_PATTERN = /\[[0-9;?]*[A-Za-z]/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent API output contract", () => {
  it("writes parseable JSON and nothing else to stdout", async () => {
    const { out } = await capture(() =>
      setupPlanCommand({
        cwd: project(),
        home: homeWithRuntime(),
        explicitKey: "PROJECT",
        ...authenticated(),
      }),
    );

    // Not "extract the JSON part" - the whole of stdout must parse.
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("emits no ANSI escapes, so output survives being piped or logged", async () => {
    const { out } = await capture(() =>
      setupPlanCommand({
        cwd: project(),
        home: homeWithRuntime(),
        explicitKey: "PROJECT",
        ...authenticated(),
      }),
    );

    expect(out).not.toMatch(ANSI_PATTERN);
  });

  it("returns a stable shape for a fresh project, and touches nothing in it", async () => {
    const root = project();
    const { out, code } = await capture(() =>
      setupPlanCommand({
        cwd: root,
        home: homeWithRuntime(),
        explicitKey: "PROJECT",
        ...authenticated(),
      }),
    );
    const payload = JSON.parse(out);

    expect(payload).toMatchObject({
      status: "ready_to_apply",
      requiresUserAction: false,
      changesApplied: false,
    });
    // Personal is the default scope: the plan records the binding for this
    // user and proposes nothing inside the repository.
    expect(payload.changes.map((c: { type: string; target: string }) => `${c.type}:${c.target}`)).toEqual([
      "create:personal-binding",
    ]);
    expect(code).toBe(0);
  });

  it("plans the repository files only when the team scope is asked for", async () => {
    const { out } = await capture(() =>
      setupPlanCommand({
        cwd: project(),
        home: homeWithRuntime(),
        explicitKey: "PROJECT",
        shared: true,
        ...authenticated(),
      }),
    );

    expect(
      JSON.parse(out).changes.map((c: { type: string; target: string }) => `${c.type}:${c.target}`),
    ).toEqual(["create:project-config", "create:mcp-config"]);
  });

  it("reports selection required with a machine-readable code, not prose", async () => {
    const root = project();
    const { out, code } = await capture(() =>
      setupPlanCommand({ cwd: root, home: homeWithRuntime(), ...unauthenticated() }),
    );
    const payload = JSON.parse(out);

    expect(payload.code).toBe("JAM_PROJECT_SELECTION_REQUIRED");
    expect(payload.requiresUserAction).toBe(true);
    expect(payload.changes).toEqual([]);
    expect(code).toBe(1);
  });
});

describe("plan / apply parity", () => {
  it("applies exactly what plan advertised, then reports nothing left to do", async () => {
    const root = project();
    const home = homeWithRuntime();

    const planned = JSON.parse(
      (
        await capture(() =>
          setupPlanCommand({ cwd: root, home, explicitKey: "PROJECT", ...authenticated() }),
        )
      ).out,
    );
    const applied = JSON.parse(
      (
        await capture(() =>
          setupApplyCommand({ cwd: root, home, explicitKey: "PROJECT", ...authenticated() }),
        )
      ).out,
    );

    expect(applied.changesApplied).toBe(true);
    expect(applied.changes).toEqual(planned.changes);

    const second = JSON.parse(
      (await capture(() => setupPlanCommand({ cwd: root, home, ...authenticated() }))).out,
    );
    expect(second.changes).toEqual([]);
    expect(second.status).toBe("already_configured");
  });

  it("plan leaves the project untouched", async () => {
    const root = project();
    const before = readdirSync(root).sort();

    await capture(() =>
      setupPlanCommand({
        cwd: root,
        home: homeWithRuntime(),
        explicitKey: "PROJECT",
        ...authenticated(),
      }),
    );

    expect(readdirSync(root).sort()).toEqual(before);
  });

  it("refuses to apply when no project key can be decided safely", async () => {
    const root = project();
    const { out, code } = await capture(() =>
      setupApplyCommand({ cwd: root, home: homeWithRuntime(), ...unauthenticated() }),
    );

    expect(JSON.parse(out).code).toBe("JAM_PROJECT_SELECTION_REQUIRED");
    expect(code).toBe(1);
    // Nothing written despite being an "apply".
    expect(readdirSync(root)).toEqual([".git"]);
  });
});

describe("auth status", () => {
  it("reports presence and origin without ever returning the credential", async () => {
    const { out } = await capture(() =>
      authStatusCommand({ cwd: project(), home: homeWithRuntime(), ...authenticated() }),
    );
    const payload = JSON.parse(out);

    expect(payload.status).toMatch(/^(configured|not_configured)$/);
    expect(payload).toHaveProperty("source");
    expect(out).not.toMatch(/apiToken|"token"|JIRA_API_TOKEN/);
  });
});

/**
 * JAM-2 (SSAFESTA Windows 실측): apply 가 변경을 실행하고도
 * status=already_configured + changesApplied=true 를 함께 돌려줬다.
 * 두 필드가 서로를 부정하면 agent 는 어느 쪽이든 믿을 수 있다.
 */
describe("setup apply — status and changesApplied agree", () => {
  it("변경을 실행한 apply 는 applied 라고 말한다", async () => {
    const root = project();
    const home = homeWithRuntime();
    const applied = JSON.parse(
      (
        await capture(() =>
          setupApplyCommand({ cwd: root, home, explicitKey: "PROJECT", ...authenticated() }),
        )
      ).out,
    );
    expect(applied.changesApplied).toBe(true);
    expect(applied.status).toBe("applied");
  });

  it("실행할 변경이 없던 apply 만 already_configured 다", async () => {
    const root = project();
    const home = homeWithRuntime();
    await capture(() =>
      setupApplyCommand({ cwd: root, home, explicitKey: "PROJECT", ...authenticated() }),
    );
    const second = JSON.parse(
      (await capture(() => setupApplyCommand({ cwd: root, home, ...authenticated() }))).out,
    );
    expect(second.changesApplied).toBe(false);
    expect(second.status).toBe("already_configured");
  });
});
