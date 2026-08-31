import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../support/temp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAUNCHER_PACKAGE_SPEC } from "../../src/bootstrap/mcp-config-merger.js";
import type { HostRunResult } from "../../src/bootstrap/host-mcp.js";
import { doctorJsonCommand } from "../../src/cli/agent-api.js";
import { TOOL_NAMES } from "../../src/mcp/create-server.js";

/**
 * The defect these cover: every local check passed while the agent was talking
 * to an older server through a stale host registration, and doctor called that
 * ready. Package, registration and live tool set are three questions.
 */

const listing = (entry: string): HostRunResult => ({
  status: 0,
  failed: false,
  stdout: [entry, "other  npx", ""].join("\n"),
});

const noEntry = (): HostRunResult => ({ status: 0, failed: false, stdout: "other  npx\n" });

function fixture(): { root: string; home: string } {
  const base = tempDir("jam-doctor-");
  const root = join(base, "project");
  const home = join(base, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, "package.json"), "{}\n");
  return { root, home };
}

function captureJson(): { read: () => any } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    chunks.push(String(chunk));
    return true;
  });
  return { read: () => JSON.parse(chunks.join("")) };
}

describe("doctor — three axes", () => {
  let capture: { read: () => any };

  beforeEach(() => {
    capture = captureJson();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a stale host registration instead of calling it ready", async () => {
    const { root, home } = fixture();

    await doctorJsonCommand({
      cwd: root,
      home,
      runHost: () => listing("jam  npx --yes @jam-mcp/launcher@1.0.1 serve  enabled"),
      // The live check must not run against a launcher we already know is stale.
      toolsetProbe: async () => {
        throw new Error("should not be probed");
      },
    });

    const output = capture.read();
    expect(output.axes.registration).toBe("HOST_REGISTRATION_STALE");
    expect(output.axes.registeredVersion).toBe("1.0.1");
    expect(output.axes.live).toBe("UNCHECKED");
    expect(output.status).toBe("failed");
  });

  it("catches a current registration that serves fewer tools than this release defines", async () => {
    const { root, home } = fixture();

    await doctorJsonCommand({
      cwd: root,
      home,
      runHost: () => listing(`jam  npx --yes ${LAUNCHER_PACKAGE_SPEC} serve  enabled`),
      toolsetProbe: async () => ["jira_context", "jira_full", "jira_search"],
    });

    const output = capture.read();
    expect(output.axes.registration).toBe("OK");
    expect(output.axes.live).toBe("LIVE_TOOLSET_MISMATCH");
    expect(output.axes.missingTools).toEqual(["jira_write_apply", "jira_write_plan"]);
    expect(output.status).toBe("failed");
  });

  it("passes the registration and live axes when the entry serves the whole contract", async () => {
    const { root, home } = fixture();

    await doctorJsonCommand({
      cwd: root,
      home,
      runHost: () => listing(`jam  npx --yes ${LAUNCHER_PACKAGE_SPEC} serve  enabled`),
      toolsetProbe: async () => [...TOOL_NAMES],
    });

    const output = capture.read();
    expect(output.axes.registration).toBe("OK");
    expect(output.axes.live).toBe("OK");
  });

  it("says unregistered rather than checking a server nobody registered", async () => {
    const { root, home } = fixture();

    await doctorJsonCommand({ cwd: root, home, runHost: noEntry });

    const output = capture.read();
    expect(output.axes.registration).toBe("UNREGISTERED");
    expect(output.axes.live).toBe("UNCHECKED");
  });
});
