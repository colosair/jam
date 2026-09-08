import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyWritePlan } from "../../src/application/apply-write.js";
import { planWrite } from "../../src/application/plan-write.js";
import { WritePlanStore } from "../../src/application/write-plan-store.js";
import { runJiraWrite } from "../../src/cli/jira-write.js";
import type { JamDeps } from "../../src/deps.js";
import { FakeJira, FakeJiraWrite, issue, testConfig, testDeps } from "../helpers.js";

/**
 * Writing from the shell, when the MCP tools are not reachable.
 *
 * A session whose MCP registry came up failed cannot be shown the write tools -
 * Claude Code has no reload surface for a running session - while JAM, its
 * credentials and its Jira access are all fine. The reads got a shell address
 * first (cli/jira-read.ts); this is the other half.
 *
 * Two things are fixed here. The transport contract: one JSON document, no
 * prompts, no payload on apply. And the integrity that replaces the in-process
 * plan store: a plan on disk is checked against its own input before anything
 * is sent.
 */

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, write: (t: string) => out.push(t), warn: (t: string) => err.push(t) };
};

const storeRoot = () => mkdtempSync(join(tmpdir(), "jam-cli-write-"));

const UPDATED = "2026-08-25T12:00:00.000+0900";

/**
 * A read port that shows what the write port did.
 *
 * Apply confirms by reading, so a fake whose reads ignore its own writes can
 * never produce an applied receipt - the verification step is doing its job.
 */
function linkedJira(jiraWrite: FakeJiraWrite): FakeJira {
  const jira = new FakeJira({
    issues: [issue({ key: "PROJECT-1", issueId: "10001", updated: UPDATED })],
  });
  const original = jira.getIssue.bind(jira);
  jira.getIssue = async (req) => {
    const result = await original(req);
    if (result.issue) {
      result.issue = {
        ...result.issue,
        comments: jiraWrite.comments.map((c, index) => ({
          id: String(index + 1),
          author: "tester",
          body: c.body,
          created: UPDATED,
        })),
        ...(jiraWrite.updates.at(-1)?.fields ?? {}),
      };
    }
    return result;
  };
  return jira;
}

function writeDeps(root: string, jiraWrite = new FakeJiraWrite()): JamDeps {
  return testDeps(linkedJira(jiraWrite), testConfig(), jiraWrite, new WritePlanStore({ root }));
}

const planFile = (root: string): string => join(root, readdirSync(root)[0] as string);

describe("jam jira write-plan - decides, changes nothing", () => {
  it("returns the same receipt the tool returns, as one JSON document", async () => {
    const root = storeRoot();
    const jiraWrite = new FakeJiraWrite();
    const io = capture();

    const code = await runJiraWrite(
      ["write-plan", "--key", "PROJECT-1", "--operation", "comment.add", "--input", '{"text":"from the shell"}'],
      { deps: writeDeps(root, jiraWrite), write: io.write, warn: io.warn },
    );

    expect(code).toBe(0);
    expect(io.out).toHaveLength(1);
    const receipt = JSON.parse(io.out[0] as string) as { status: string; planId: string };
    expect(receipt.status).toBe("planned");
    expect(receipt.planId).toBeTruthy();
    expect(io.err).toEqual([]);
    // Planning reads. The whole point of the two-call shape is that this half
    // cannot have written anything.
    expect(jiraWrite.comments).toHaveLength(0);
  });

  it("a refusal is the same normalized code the tool produces", async () => {
    const io = capture();
    const code = await runJiraWrite(
      ["write-plan", "--key", "OTHER-1", "--operation", "comment.add", "--input", '{"text":"x"}'],
      { deps: writeDeps(storeRoot()), write: io.write, warn: io.warn },
    );

    expect(code).toBe(1);
    expect(JSON.parse(io.out[0] as string)).toMatchObject({
      error: { code: "JAM_WRITE_SCOPE_VIOLATION" },
    });
  });

  it("--input must be a JSON object, and says so on stderr", async () => {
    const io = capture();
    const code = await runJiraWrite(
      ["write-plan", "--key", "PROJECT-1", "--operation", "comment.add", "--input", "not json"],
      { deps: writeDeps(storeRoot()), write: io.write, warn: io.warn },
    );
    expect(code).toBe(1);
    expect(io.out).toEqual([]);
    expect(io.err.join("")).toMatch(/JSON object/);
  });
});

describe("jam jira write-apply - takes a planId and nothing else", () => {
  it("applies a plan the same process made", async () => {
    const root = storeRoot();
    const jiraWrite = new FakeJiraWrite();
    const deps = writeDeps(root, jiraWrite);
    const io = capture();

    await runJiraWrite(
      ["write-plan", "--key", "PROJECT-1", "--operation", "comment.add", "--input", '{"text":"hello"}'],
      { deps, write: io.write, warn: io.warn },
    );
    const { planId } = JSON.parse(io.out[0] as string) as { planId: string };

    const applied = capture();
    const code = await runJiraWrite(["write-apply", planId], {
      deps,
      write: applied.write,
      warn: applied.warn,
    });

    expect(code).toBe(0);
    expect(JSON.parse(applied.out[0] as string)).toMatchObject({ status: "applied", verified: true });
    expect(jiraWrite.comments).toHaveLength(1);
  });

  it("a plan planned in one process applies in another", async () => {
    // The reason the store became a file. Two stores over one directory is what
    // two `jam` invocations are.
    const root = storeRoot();
    const jiraWrite = new FakeJiraWrite();
    const planning = writeDeps(root, jiraWrite);
    const io = capture();
    await runJiraWrite(
      ["write-plan", "--key", "PROJECT-1", "--operation", "comment.add", "--input", '{"text":"across"}'],
      { deps: planning, write: io.write, warn: io.warn },
    );
    const { planId } = JSON.parse(io.out[0] as string) as { planId: string };

    const applying = writeDeps(root, jiraWrite);
    const applied = capture();
    const code = await runJiraWrite(["write-apply", planId], {
      deps: applying,
      write: applied.write,
      warn: applied.warn,
    });

    expect(code).toBe(0);
    expect(jiraWrite.comments).toHaveLength(1);
  });

  it("a plan made through the application layer applies from the shell", async () => {
    // MCP calls planWrite directly. This is the case the change exists for: the
    // tools stop answering after planning, and the shell finishes the write.
    const root = storeRoot();
    const jiraWrite = new FakeJiraWrite();
    const deps = writeDeps(root, jiraWrite);
    const { plan } = await planWrite(deps, {
      key: "PROJECT-1",
      operation: "comment.add",
      input: { text: "planned through MCP" },
    });

    const io = capture();
    const code = await runJiraWrite(["write-apply", plan.planId], {
      deps: writeDeps(root, jiraWrite),
      write: io.write,
      warn: io.warn,
    });

    expect(code).toBe(0);
    expect(jiraWrite.comments).toHaveLength(1);
  });

  it("takes exactly one planId and offers no way to pass a payload", async () => {
    const io = capture();
    const code = await runJiraWrite(["write-apply"], {
      deps: writeDeps(storeRoot()),
      write: io.write,
      warn: io.warn,
    });
    expect(code).toBe(1);
    expect(io.err.join("")).toMatch(/exactly one planId/);

    // Not an accident of parsing: the usage text is the contract, and it names
    // no field, payload or override.
    const source = readFileSync(new URL("../../src/cli/jira-write.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/--payload|--field|--override/);
  });
});

describe("a plan on disk is checked against itself", () => {
  const tamper = (root: string, edit: (plan: Record<string, unknown>) => void): void => {
    const path = planFile(root);
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    edit(stored);
    writeFileSync(path, JSON.stringify(stored), "utf8");
  };

  it("an edited mutation is refused, and nothing is sent", async () => {
    const root = storeRoot();
    const jiraWrite = new FakeJiraWrite();
    const deps = writeDeps(root, jiraWrite);
    const { plan } = await planWrite(deps, {
      key: "PROJECT-1",
      operation: "comment.add",
      input: { text: "what the plan says" },
    });

    tamper(root, (stored) => {
      stored["mutation"] = { kind: "comment", text: "something else entirely" };
    });

    await expect(
      applyWritePlan(writeDeps(root, jiraWrite), { planId: plan.planId }),
    ).rejects.toMatchObject({ code: "JAM_WRITE_PLAN_TAMPERED" });
    expect(jiraWrite.comments).toHaveLength(0);
  });

  it("an input outside the whitelist is refused even when the mutation agrees", async () => {
    const root = storeRoot();
    const jiraWrite = new FakeJiraWrite();
    const deps = writeDeps(root, jiraWrite);
    const { plan } = await planWrite(deps, {
      key: "PROJECT-1",
      operation: "field.update",
      input: { summary: "planned" },
    });

    // Rewriting both is the interesting case: re-deriving has to run the
    // whitelist too, or an edited plan gets to write a field planning refuses.
    tamper(root, (stored) => {
      stored["input"] = { reporter: "someone" };
      stored["mutation"] = { kind: "fields", fields: { reporter: "someone" } };
    });

    await expect(
      applyWritePlan(writeDeps(root, jiraWrite), { planId: plan.planId }),
    ).rejects.toMatchObject({ code: "JAM_WRITE_PLAN_TAMPERED" });
    expect(jiraWrite.updates).toHaveLength(0);
  });

  it("a plan file nobody planned is refused", async () => {
    const root = storeRoot();
    const jiraWrite = new FakeJiraWrite();
    const forged = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    writeFileSync(
      join(root, `${forged}.json`),
      JSON.stringify({
        planId: forged,
        kind: "existing-issue",
        issueKey: "PROJECT-1",
        issueId: "10001",
        projectKey: "PROJECT",
        operation: "comment.add",
        before: { comments: 0 },
        intendedAfter: { commentAdded: "forged" },
        baseUpdated: UPDATED,
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2999-01-01T00:00:00.000Z",
        // The mutation someone wants, with an input that does not produce it.
        mutation: { kind: "comment", text: "forged" },
        input: { text: "not the same text" },
      }),
      "utf8",
    );

    await expect(
      applyWritePlan(writeDeps(root, jiraWrite), { planId: forged }),
    ).rejects.toMatchObject({ code: "JAM_WRITE_PLAN_TAMPERED" });
    expect(jiraWrite.comments).toHaveLength(0);
  });
});
