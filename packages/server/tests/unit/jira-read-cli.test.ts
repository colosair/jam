import { describe, expect, it } from "vitest";
import { runJiraRead } from "../../src/cli/jira-read.js";
import { FakeJira, issue, testDeps } from "../helpers.js";

/**
 * A session that registers JAM cannot be shown the new MCP tools - Claude Code
 * has no reload surface for a running session. Without a shell-addressable read
 * the agent answered Jira questions from the code host and the repository,
 * which is the substitution JAM exists to prevent.
 *
 * These fix the shape of that alternative: same reads, one JSON document, and
 * no second source of truth.
 */
describe("jam jira - reads addressed to the shell", () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, write: (t: string) => out.push(t), warn: (t: string) => err.push(t) };
  };

  it("search returns the same result the tool returns, as one JSON document", async () => {
    const jira = new FakeJira({ pages: [{ issues: [issue({ key: "ABC-1" })] }] });
    const io = capture();
    const code = await runJiraRead(["search", "project = ABC ORDER BY updated DESC"], {
      deps: testDeps(jira),
      write: io.write,
      warn: io.warn,
    });

    expect(code).toBe(0);
    expect(io.out).toHaveLength(1);
    const parsed = JSON.parse(io.out[0] as string);
    expect(parsed.issues[0].key).toBe("ABC-1");
    // meta is the whole point of JAM's reads - a shell caller gets it too.
    expect(parsed.meta.complete).toBeDefined();
    expect(parsed.meta.evidenceScope).toBeDefined();
    expect(io.err).toEqual([]);
  });

  it("a JQL query with spaces stays one query", async () => {
    const jira = new FakeJira({ pages: [{ issues: [] }] });
    await runJiraRead(["search", "project", "=", "ABC", "AND", "statusCategory", "!=", "Done"], {
      deps: testDeps(jira),
      ...capture(),
    });
    expect(jira.searchCalls[0]?.jql).toBe("project = ABC AND statusCategory != Done");
  });

  it("context and full read the keys they were given", async () => {
    const jira = new FakeJira({ issues: [issue({ key: "ABC-1" }), issue({ key: "ABC-2" })] });
    const io = capture();
    expect(await runJiraRead(["context", "ABC-1", "ABC-2"], { deps: testDeps(jira), ...io })).toBe(0);
    const parsed = JSON.parse(io.out[0] as string);
    expect(parsed.issues.map((i: { key: string }) => i.key)).toEqual(["ABC-1", "ABC-2"]);

    const full = capture();
    expect(await runJiraRead(["full", "ABC-1"], { deps: testDeps(jira), ...full })).toBe(0);
    expect(JSON.parse(full.out[0] as string).issues[0].key).toBe("ABC-1");
  });

  it("scope is passed through, and a bad one is refused before any read", async () => {
    const jira = new FakeJira({ pages: [{ issues: [] }] });
    await runJiraRead(["search", "project = ABC", "--scope", "complete"], { deps: testDeps(jira), ...capture() });
    expect(jira.searchCalls.length).toBeGreaterThan(0);

    const bad = new FakeJira({ pages: [{ issues: [] }] });
    const io = capture();
    expect(await runJiraRead(["search", "project = ABC", "--scope", "sideways"], { deps: testDeps(bad), ...io })).toBe(1);
    expect(bad.searchCalls).toEqual([]);
    expect(io.out).toEqual([]);
  });

  it("a failure is the normalized code the tools produce, on stdout, exit 1", async () => {
    const jira = new FakeJira({ pages: [] });
    // The read port refuses; the CLI must turn that into JAM's own code.
    Object.assign(jira, {
      searchPage: async () => {
        throw Object.assign(new Error("401 Unauthorized"), { status: 401 });
      },
    });
    const io = capture();
    const code = await runJiraRead(["search", "project = ABC"], { deps: testDeps(jira), ...io });
    expect(code).toBe(1);
    expect(JSON.parse(io.out[0] as string).error.code).toBeDefined();
  });

  it("usage goes to stderr so stdout stays one JSON document", async () => {
    const io = capture();
    expect(await runJiraRead(["nonsense"], { deps: testDeps(new FakeJira({})), ...io })).toBe(1);
    expect(io.out).toEqual([]);
    expect(io.err.join("")).toContain("jam jira search");
  });
});
