import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/mcp/create-server.js";
import type { JamDeps } from "../../src/deps.js";
import { FakeJira, issue, testDeps } from "../helpers.js";

/**
 * The external contract is the one thing that must not drift: exactly three
 * read tools, fixed input shapes, and a `meta` block on every result.
 */
async function connect(deps: JamDeps): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract-test", version: "0" });
  await Promise.all([
    createServer(deps).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function payload(result: unknown): any {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]!.text);
}

describe("tool contract", () => {
  let jira: FakeJira;
  let client: Client;

  beforeEach(async () => {
    jira = new FakeJira({
      pages: [{ issues: [issue({ key: "PROJECT-101" })], responseBytes: 20 }],
      issues: [
        issue({
          key: "PROJECT-97",
          description: "Agreed on v2.",
          comments: [{ id: "1", created: "2026-01-01", body: "LGTM" }],
        }),
      ],
      commentTotals: { "PROJECT-97": 1 },
    });
    client = await connect(testDeps(jira));
  });

  it("exposes exactly jira_search, jira_context and jira_full", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["jira_context", "jira_full", "jira_search"]);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("declares the fixed input shapes", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));

    expect(Object.keys(byName["jira_search"]!.properties ?? {}).sort()).toEqual(["jql", "scope"]);
    expect(byName["jira_search"]!.required).toEqual(["jql"]);
    expect(Object.keys(byName["jira_context"]!.properties ?? {})).toEqual(["issueKeys"]);
    expect(Object.keys(byName["jira_full"]!.properties ?? {})).toEqual(["issueKeys"]);
  });

  it("jira_search returns lite issues plus completeness metadata", async () => {
    const result = payload(
      await client.callTool({ name: "jira_search", arguments: { jql: "project = PROJECT" } }),
    );

    expect(result.meta).toMatchObject({ level: "search", complete: true });
    expect(result.meta.fetchedAt).toBeTruthy();
    expect(result.issues[0]).not.toHaveProperty("description");
    expect(result.issues[0]).not.toHaveProperty("comments");
  });

  it("jira_context returns context metadata", async () => {
    const result = payload(
      await client.callTool({ name: "jira_context", arguments: { issueKeys: ["PROJECT-97"] } }),
    );

    expect(result.meta).toMatchObject({ level: "context", complete: true });
    expect(result.issues[0]).toHaveProperty("links");
    expect(result.issues[0]).not.toHaveProperty("comments");
  });

  it("jira_full returns description, comments and comment completeness", async () => {
    const result = payload(
      await client.callTool({ name: "jira_full", arguments: { issueKeys: ["PROJECT-97"] } }),
    );

    expect(result.meta).toMatchObject({ level: "full", complete: true, commentsComplete: true });
    expect(result.issues[0].description).toBe("Agreed on v2.");
    expect(result.issues[0].comments[0].body).toBe("LGTM");
  });

  it("returns a normalized error payload instead of a stack trace", async () => {
    const raw = await client.callTool({
      name: "jira_context",
      arguments: { issueKeys: ["not-a-key"] },
    });

    expect((raw as { isError?: boolean }).isError).toBe(true);
    const body = payload(raw);
    expect(body.error.code).toBe("CONFIG_INVALID");
    expect(JSON.stringify(body)).not.toMatch(/at .*\.ts:/);
  });

  it("rejects input that violates the declared schema", async () => {
    const raw = await client.callTool({ name: "jira_search", arguments: { jql: "" } });

    expect((raw as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(raw)).toMatch(/validation/i);
    // the invalid call must never have reached Jira
    expect(jira.searchCalls).toHaveLength(0);
  });
});
