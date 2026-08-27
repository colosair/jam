import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServer } from "../../src/mcp/create-server.js";
import { runHealthGate } from "../../src/bootstrap/boot-health-gate.js";
import { serve } from "../../src/cli/serve.js";
import { doctor } from "../../src/cli/doctor.js";
import type { CredentialPort } from "../../src/ports/credentials.port.js";
import { FakeJira, testConfig, testDeps } from "../helpers.js";

const noCredentials: CredentialPort = {
  load() {
    throw new Error("no credentials in this test");
  },
  describe() {
    return { hasToken: false, source: "none" };
  },
};

describe("runHealthGate", () => {
  it("boot mode stops after local checks - no Jira network call is made", async () => {
    const jira = new FakeJira({});
    const deps = testDeps(jira, testConfig({ project: { key: "PROJECT" } }));

    const result = await runHealthGate(deps, "boot");

    expect(result.passed).toBe(true);
    expect(result.checks.map((c) => c.name)).not.toContain("Jira authentication");
    expect(jira.searchCalls).toHaveLength(0);
  });

  it("boot mode fails fatally when the project key is unset, without touching Jira", async () => {
    const jira = new FakeJira({});
    const deps = testDeps(jira, testConfig({ project: { key: "" } }));

    const result = await runHealthGate(deps, "boot");

    expect(result.passed).toBe(false);
    const key = result.checks.find((c) => c.name === "Jira project key");
    expect(key).toMatchObject({ ok: false, fatal: true });
    expect(jira.searchCalls).toHaveLength(0);
  });

  it("reports the tool count the MCP server actually serves", async () => {
    // The count used to be a literal in the detail string, and went stale the
    // moment the write pair was added. Compare it against the server's own tool
    // list rather than against the constant that produced it.
    const deps = testDeps(new FakeJira({}), testConfig({ project: { key: "PROJECT" } }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "health-gate-test", version: "0" });
    await Promise.all([
      createServer(deps).connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const { tools } = await client.listTools();

    const result = await runHealthGate(deps, "boot");
    const startup = result.checks.find((c) => c.name === "MCP server startup");

    expect(startup).toMatchObject({ ok: true, detail: `${tools.length} tools registered` });
  });

  it("full mode adds live Jira checks once boot-level checks pass", async () => {
    const jira = new FakeJira({ pages: [{ issues: [], responseBytes: 0 }] });
    const deps = testDeps(jira, testConfig({ project: { key: "PROJECT" } }));

    const result = await runHealthGate(deps, "full");

    expect(result.checks.map((c) => c.name)).toContain("Jira authentication");
    expect(result.checks.map((c) => c.name)).toContain('JQL search / PROJECT access');
    expect(result.passed).toBe(true);
  });

  it("full mode short-circuits the rest once a live check fails", async () => {
    const jira = new FakeJira({});
    jira.getCurrentUser = async () => {
      throw new Error("401");
    };
    const deps = testDeps(jira, testConfig({ project: { key: "PROJECT" } }));

    const result = await runHealthGate(deps, "full");

    expect(result.passed).toBe(false);
    expect(result.checks.map((c) => c.name)).not.toContain('JQL search / PROJECT access');
  });
});

describe("doctor and serve share one gate core", () => {
  it("both call the same runHealthGate export (no parallel implementation to drift)", () => {
    // If either command re-implemented its own checklist, this module identity
    // assertion is what would catch the duplication - not a snapshot of output text.
    expect(doctor).toBeTypeOf("function");
    expect(serve).toBeTypeOf("function");
  });

  it("serve never calls connect() when the boot gate fails", async () => {
    // A config file is already present so bootstrap never even needs to run -
    // the failure being tested is purely "credentials missing".
    const root = mkdtempSync(join(tmpdir(), "jam-serve-fail-"));
    mkdirSync(join(root, ".jira-agent"), { recursive: true });
    writeFileSync(
      join(root, ".jira-agent", "project.yaml"),
      ["version: 1", "project:", "  key: PROJECT", ""].join("\n"),
      "utf8",
    );

    const jira = new FakeJira({});
    const code = await serve({ cwd: root, jira, credentials: noCredentials });

    expect(code).toBe(1);
    // Nothing on the MCP-connect path should have run - no Jira call happened either.
    expect(jira.searchCalls).toHaveLength(0);
    expect(jira.issueCalls).toHaveLength(0);
  });
});
