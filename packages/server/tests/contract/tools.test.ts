import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createServer, SERVER_NAME, TOOL_NAMES } from "../../src/mcp/create-server.js";
import type { JamDeps } from "../../src/deps.js";
import { FakeJira, issue, testDeps } from "../helpers.js";

/**
 * The external contract is the one thing that must not drift: three read tools
 * and two write tools, fixed input shapes, and a `meta` block on every read
 * result.
 */
const READ_TOOLS = ["jira_context", "jira_full", "jira_search"];
const WRITE_TOOLS = ["jira_write_apply", "jira_write_plan"];
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

  it("exposes exactly the three read tools and the two write tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
    }
  });

  it("identifies itself as jam, and serves exactly five tools", async () => {
    // The count is the cheapest thing to check and the first thing to drift.
    // Named separately from the name list above so a failure says which of the
    // two went wrong: an added tool, or a renamed one.
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(5);
  });

  it("gives jira_write_apply no input but a planId", async () => {
    // This is the whole safety argument for splitting the write in two: with
    // no payload on the apply step, there is nothing to override what the plan
    // decided, and no way to write without planning first. An extra property
    // here would quietly reopen that.
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "jira_write_apply")?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(Object.keys(schema?.properties ?? {})).toEqual(["planId"]);
    expect(schema?.required).toEqual(["planId"]);
  });

  it("marks the read tools read-only, and only the apply step as writing", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));

    for (const name of READ_TOOLS) {
      expect(byName[name]?.readOnlyHint).toBe(true);
    }
    // Planning reads and decides; a host that asks before mutations should not
    // be asking about it.
    expect(byName["jira_write_plan"]?.readOnlyHint).toBe(true);
    expect(byName["jira_write_plan"]?.destructiveHint).toBe(false);
    // Apply is the one call in JAM that changes anything.
    expect(byName["jira_write_apply"]?.readOnlyHint).toBe(false);
    expect(byName["jira_write_apply"]?.idempotentHint).toBe(false);
  });

  it("carries every write as an operation, never as another tool", async () => {
    // The whole point of the plan/apply shape is that adding what JAM can
    // write does not widen what an agent has to know. A new operation belongs
    // in the enum; a new tool would be a breaking change to the contract.
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "jira_write_plan")?.inputSchema as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };

    expect(schema?.properties?.["operation"]?.enum).toEqual([
      "comment.add",
      "field.update",
      "status.transition",
      "assignee.update",
      "issue.create",
    ]);
    // `key` is not required, because issue.create has no issue to name. The
    // operations that do have one are refused without it at the server.
    expect(schema?.required).toEqual(["operation", "input"]);
  });

  it("hands an unknown write field to JAM rather than dropping it at the schema", async () => {
    // A stripping schema would answer this by creating an issue with no
    // assignee and a receipt that never mentions one was asked for. The
    // refusal has to come from JAM, by name, with the supported list.
    const result = await client.callTool({
      name: "jira_write_plan",
      arguments: {
        operation: "issue.create",
        input: { issueType: "Task", summary: "x", assignee: "someone" },
      },
    });

    expect(payload(result)).toMatchObject({
      error: { code: "JAM_WRITE_FIELD_NOT_ALLOWED", details: { rejected: ["assignee"] } },
    });
  });

  it("states the evidence boundary in every read tool description", async () => {
    const { tools } = await client.listTools();

    // An agent reads the description before it reads a result. If only
    // jira_full says what was not evaluated, the other two invite exactly the
    // conclusion JAM cannot support.
    for (const tool of tools.filter((t) => READ_TOOLS.includes(t.name))) {
      expect(tool.description).toContain("Repository and external sources are not evaluated.");
    }
  });

  it("tells an agent how the write pair fits together, in the descriptions", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));

    expect(byName["jira_write_plan"]).toContain("Changes nothing.");
    expect(byName["jira_write_apply"]).toContain("This changes Jira.");
    // The one failure an agent must not treat as "try again".
    expect(byName["jira_write_apply"]).toContain("JAM_WRITE_UNCERTAIN");
    expect(byName["jira_write_apply"]).toContain("Do NOT call this tool again");
  });

  it("carries the evidence boundary on every result", async () => {
    const results = [
      payload(
        await client.callTool({ name: "jira_search", arguments: { jql: "project = PROJECT" } }),
      ),
      payload(
        await client.callTool({ name: "jira_context", arguments: { issueKeys: ["PROJECT-97"] } }),
      ),
      payload(
        await client.callTool({ name: "jira_full", arguments: { issueKeys: ["PROJECT-97"] } }),
      ),
    ];

    for (const result of results) {
      expect(result.meta).toMatchObject({
        source: "jira",
        provenance: "live",
        evidenceScope: "jira-records-only",
      });
      // Stable codes, so a consumer can branch instead of matching prose.
      expect(result.meta.limitations).toEqual([
        "REPOSITORY_NOT_EVALUATED",
        "EXTERNAL_SOURCES_NOT_EVALUATED",
        "NON_JIRA_DEPENDENCIES_NOT_EVALUATED",
      ]);
    }
  });

  it("declares the fixed input shapes", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));

    expect(Object.keys(byName["jira_search"]!.properties ?? {}).sort()).toEqual(["jql", "scope"]);
    expect(byName["jira_search"]!.required).toEqual(["jql"]);
    expect(Object.keys(byName["jira_context"]!.properties ?? {})).toEqual(["issueKeys"]);
    expect(Object.keys(byName["jira_full"]!.properties ?? {})).toEqual(["issueKeys"]);

    // Apply takes a plan and nothing else. Any second property here would be a
    // way to write something the plan did not decide.
    expect(Object.keys(byName["jira_write_apply"]!.properties ?? {})).toEqual(["planId"]);
    expect(byName["jira_write_apply"]!.required).toEqual(["planId"]);
    expect(Object.keys(byName["jira_write_plan"]!.properties ?? {}).sort()).toEqual([
      "input",
      "key",
      "operation",
    ]);
  });

  it("carries Jira identity on every read result, and adds no input to get it", async () => {
    // Identity is additive output: the three read tools now name the issue by
    // Jira's immutable id as well as by its key, and nothing about how they
    // are called changed. An agent that never looks at `issueId` sees exactly
    // the contract it saw before.
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
    expect(Object.keys(byName["jira_context"]!.properties ?? {})).toEqual(["issueKeys"]);
    expect(Object.keys(byName["jira_full"]!.properties ?? {})).toEqual(["issueKeys"]);

    const search = payload(
      await client.callTool({ name: "jira_search", arguments: { jql: "project = PROJECT" } }),
    );
    expect(search.issues[0].key).toBe("PROJECT-101");
    expect(search.issues[0].issueId).toBe("id-PROJECT-101");

    for (const tool of ["jira_context", "jira_full"]) {
      const result = payload(
        await client.callTool({ name: tool, arguments: { issueKeys: ["PROJECT-97"] } }),
      );
      expect(result.issues[0].key).toBe("PROJECT-97");
      expect(result.issues[0].issueId).toBe("id-PROJECT-97");
    }
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

describe("TOOL_NAMES", () => {
  it("names exactly what a running server serves", async () => {
    const client = await connect(testDeps(new FakeJira({ pages: [], issues: [] })));
    const live = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect([...TOOL_NAMES].sort()).toEqual(live);
  });
});
