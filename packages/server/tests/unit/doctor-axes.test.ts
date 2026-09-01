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

/**
 * Per-axis diagnosis. The field complaint behind this: doctor answered
 * `failed` and the agent had to guess whether the credentials, the binding,
 * the runtime, the registration or Jira itself was the problem - and a guess
 * becomes a wrong repair. Each axis now carries its own verdict.
 */
describe("doctor — per-axis diagnosis", () => {
  let capture: { read: () => any };
  beforeEach(() => {
    capture = captureJson();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mixedCredentials = {
    load: () => {
      throw new Error("not needed");
    },
    describe: () => ({
      baseUrl: "https://example.atlassian.net",
      email: "u@example.com",
      hasToken: true,
      source: "mixed" as const,
      sources: {
        JIRA_BASE_URL: "secret-store" as const,
        JIRA_EMAIL: "secret-store" as const,
        JIRA_API_TOKEN: "process" as const,
      },
    }),
  };

  it("names every axis, so a failure never has to be guessed at", async () => {
    const { root, home } = fixture();
    await doctorJsonCommand({ cwd: root, home, runHost: noEntry });
    const output = capture.read();
    for (const axis of [
      "credentials",
      "projectBinding",
      "runtime",
      "registration",
      "liveToolset",
      "jiraAuthentication",
      "jiraProjectAccess",
    ]) {
      expect(output.diagnosis, `missing axis ${axis}`).toHaveProperty(axis);
      expect(output.diagnosis[axis].state).toMatch(/^(OK|FAILED|WARNING|UNCHECKED)$/);
    }
  });

  it("an unbound workspace is a projectBinding failure, not an unattributed one", async () => {
    const { root, home } = fixture();
    await doctorJsonCommand({ cwd: root, home, runHost: noEntry });
    const output = capture.read();
    expect(output.diagnosis.projectBinding.state).toBe("FAILED");
    expect(output.diagnosis.projectBinding.code).toBe("JAM_PROJECT_SELECTION_REQUIRED");
  });

  it("mixed credentials are a warning that names the sources, never a failure on their own", async () => {
    const { root, home } = fixture();
    await doctorJsonCommand({ cwd: root, home, runHost: noEntry, credentials: mixedCredentials });
    const output = capture.read();
    expect(output.diagnosis.credentials.state).toBe("WARNING");
    expect(output.diagnosis.credentials.detail).toContain("JIRA_API_TOKEN=process");
    expect(output.diagnosis.credentials.detail).toContain("JIRA_BASE_URL=secret-store");
    // The warning says where fields came from - never what they are.
    expect(JSON.stringify(output)).not.toContain("SECRET");
  });
});
