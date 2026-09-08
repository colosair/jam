import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runJiraWrite } from "../../src/cli/jira-write.js";
import { createServer } from "../../src/mcp/create-server.js";
import type { JamDeps } from "../../src/deps.js";
import { FakeJira, FakeJiraWrite, issue, testConfig, testDeps } from "../helpers.js";

/**
 * The two ways into the write plane must refuse the same things.
 *
 * A shell address for writes was added so a session that cannot see the MCP
 * tools can still work. That only holds if the shell is the same write plane
 * rather than a second one: a request the tools refuse must not be a request
 * the terminal accepts, and the code an agent reads must not depend on which
 * door it came through.
 *
 * The evidence here is the same bad request run through both doors, with the
 * answers compared. Reading the sources and seeing them import the same
 * constant would show why they agree; it would not show that they do.
 */

/** One deps for both transports: same config, same store, same Jira. */
function bothTransports() {
  const jiraWrite = new FakeJiraWrite();
  const deps: JamDeps = testDeps(
    new FakeJira({ issues: [issue({ key: "PROJECT-1" })] }),
    testConfig(),
    jiraWrite,
  );
  return { deps, jiraWrite };
}

async function connect(deps: JamDeps): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parity-test", version: "0" });
  await Promise.all([
    createServer(deps).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

type Refusal = { isError: boolean; code?: string; text: string };

/** What the MCP tool says, reduced to what an agent reads off it. */
async function throughTools(
  deps: JamDeps,
  args: Record<string, unknown>,
): Promise<Refusal> {
  const raw = await connect(deps).then((client) =>
    client.callTool({ name: "jira_write_plan", arguments: args }),
  );
  const text = JSON.stringify(raw);
  const content = (raw as { content?: { text: string }[] }).content?.[0]?.text;
  let code: string | undefined;
  try {
    code = (JSON.parse(content ?? "") as { error?: { code?: string } }).error?.code;
  } catch {
    // A schema refusal is not a JAM payload; `code` stays absent and the text
    // is what the caller compares.
  }
  return { isError: (raw as { isError?: boolean }).isError === true, ...(code ? { code } : {}), text };
}

/** The same, through the shell. */
async function throughShell(
  deps: JamDeps,
  args: { key?: string; operation: string; input: unknown },
): Promise<Refusal> {
  const out: string[] = [];
  const err: string[] = [];
  const exit = await runJiraWrite(
    [
      "write-plan",
      ...(args.key === undefined ? [] : ["--key", args.key]),
      "--operation",
      args.operation,
      "--input",
      JSON.stringify(args.input),
    ],
    { deps, write: (t) => out.push(t), warn: (t) => err.push(t) },
  );
  const text = out.join("") || err.join("");
  let code: string | undefined;
  try {
    code = (JSON.parse(out[0] ?? "") as { error?: { code?: string } }).error?.code;
  } catch {
    // Argument-shape complaints go to stderr as prose, by design.
  }
  return { isError: exit !== 0, ...(code ? { code } : {}), text };
}

describe("a refusal is the same refusal through either transport", () => {
  const cases: { name: string; args: { key?: string; operation: string; input: unknown }; code: string }[] = [
    {
      name: "a key from another project",
      args: { key: "OTHER-1", operation: "comment.add", input: { text: "x" } },
      code: "JAM_WRITE_SCOPE_VIOLATION",
    },
    {
      name: "a field outside the whitelist",
      args: { key: "PROJECT-1", operation: "field.update", input: { reporter: "someone" } },
      code: "JAM_WRITE_FIELD_NOT_ALLOWED",
    },
    {
      name: "an operation that needs a key, without one",
      args: { operation: "comment.add", input: { text: "x" } },
      code: "JAM_WRITE_OPERATION_NOT_ALLOWED",
    },
  ];

  for (const { name, args, code } of cases) {
    it(`${name}: both refuse with ${code}`, async () => {
      const tools = bothTransports();
      const shell = bothTransports();

      const viaTools = await throughTools(tools.deps, args);
      const viaShell = await throughShell(shell.deps, args);

      expect(viaTools.code).toBe(code);
      expect(viaShell.code).toBe(code);
      // Refusing with the same word is only half of it. Neither door may have
      // reached Jira on the way to saying no.
      expect(tools.jiraWrite.mutations).toBe(0);
      expect(shell.jiraWrite.mutations).toBe(0);
    });
  }

  it("an operation JAM does not have is refused by both, in different words", async () => {
    // Measured, not assumed: the tool declares `operation` as an enum, so the
    // MCP schema turns this away before the application sees it, while the
    // shell passes the string on and the application names it. Both refuse and
    // neither writes - that is the invariant. Asserting one shared code here
    // would be asserting something that is not true.
    const tools = bothTransports();
    const shell = bothTransports();
    const args = { key: "PROJECT-1", operation: "issue.delete", input: {} };

    const viaTools = await throughTools(tools.deps, args);
    const viaShell = await throughShell(shell.deps, args);

    expect(viaTools.isError).toBe(true);
    expect(viaTools.text).toMatch(/validation/i);
    expect(viaShell.code).toBe("JAM_WRITE_OPERATION_NOT_ALLOWED");
    expect(tools.jiraWrite.mutations).toBe(0);
    expect(shell.jiraWrite.mutations).toBe(0);
  });
});

describe("why the two agree", () => {
  const source = (path: string): string =>
    readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

  it("neither transport keeps its own idea of what a write is", () => {
    // Supporting evidence for the runs above: they agree because there is one
    // operation list and one application path, not because two lists happen to
    // match today. A hardcoded list appearing on either side is what this
    // catches, and it is what would make the runs above start to diverge.
    const tool = source("mcp/tools/jira-write-plan.tool.ts");
    const cli = source("cli/jira-write.ts");

    for (const file of [tool, cli]) {
      // Imported from the one domain module, never restated locally.
      expect(file).toMatch(/import \{[^}]*WRITE_OPERATIONS[^}]*\} from "[./]*domain\/write\.js"/s);
      expect(file).not.toMatch(/WRITE_OPERATIONS\s*=/);
    }
    expect(tool).toMatch(/planWrite/);
    expect(cli).toMatch(/planWrite/);
    expect(source("mcp/tools/jira-write-apply.tool.ts")).toMatch(/applyWritePlan/);
    expect(cli).toMatch(/applyWritePlan/);
  });
});
