import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authStatusCommand,
  setupApplyCommand,
  setupPlanCommand,
} from "../../src/cli/agent-api.js";

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
      setupPlanCommand({ cwd: project(), home: homeWithRuntime(), explicitKey: "PROJECT" }),
    );

    // Not "extract the JSON part" - the whole of stdout must parse.
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("emits no ANSI escapes, so output survives being piped or logged", async () => {
    const { out } = await capture(() =>
      setupPlanCommand({ cwd: project(), home: homeWithRuntime(), explicitKey: "PROJECT" }),
    );

    expect(out).not.toMatch(ANSI_PATTERN);
  });

  it("returns a stable shape for a fresh project", async () => {
    const { out, code } = await capture(() =>
      setupPlanCommand({ cwd: project(), home: homeWithRuntime(), explicitKey: "PROJECT" }),
    );
    const payload = JSON.parse(out);

    expect(payload).toMatchObject({
      status: "ready_to_apply",
      requiresUserAction: false,
      changesApplied: false,
    });
    expect(payload.changes.map((c: { type: string; target: string }) => `${c.type}:${c.target}`)).toEqual([
      "create:project-config",
      "create:mcp-config",
    ]);
    expect(code).toBe(0);
  });

  it("reports selection required with a machine-readable code, not prose", async () => {
    const root = project();
    const { out, code } = await capture(() =>
      setupPlanCommand({ cwd: root, home: homeWithRuntime() }),
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
      (await capture(() => setupPlanCommand({ cwd: root, home, explicitKey: "PROJECT" }))).out,
    );
    const applied = JSON.parse(
      (await capture(() => setupApplyCommand({ cwd: root, home, explicitKey: "PROJECT" }))).out,
    );

    expect(applied.changesApplied).toBe(true);
    expect(applied.changes).toEqual(planned.changes);

    const second = JSON.parse((await capture(() => setupPlanCommand({ cwd: root, home }))).out);
    expect(second.changes).toEqual([]);
    expect(second.status).toBe("already_configured");
  });

  it("plan leaves the project untouched", async () => {
    const root = project();
    const before = readdirSync(root).sort();

    await capture(() => setupPlanCommand({ cwd: root, home: homeWithRuntime(), explicitKey: "PROJECT" }));

    expect(readdirSync(root).sort()).toEqual(before);
  });

  it("refuses to apply when no project key can be decided safely", async () => {
    const root = project();
    const { out, code } = await capture(() =>
      setupApplyCommand({ cwd: root, home: homeWithRuntime() }),
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
      authStatusCommand({ cwd: project(), home: homeWithRuntime() }),
    );
    const payload = JSON.parse(out);

    expect(payload.status).toMatch(/^(configured|not_configured)$/);
    expect(payload).toHaveProperty("source");
    expect(out).not.toMatch(/apiToken|"token"|JIRA_API_TOKEN/);
  });
});
