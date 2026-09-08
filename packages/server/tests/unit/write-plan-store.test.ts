import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WritePlanStore } from "../../src/application/write-plan-store.js";
import { JamError } from "../../src/domain/errors.js";
import type { NewWritePlan } from "../../src/domain/write.js";

/**
 * Plans became files so both transports can reach one.
 *
 * The reason is `jam jira write-plan` and `jam jira write-apply`: two processes,
 * so an in-memory plan is gone before apply can see it. Sharing the store also
 * means a plan made through MCP survives the tools going stale, which is what
 * the CLI write surface exists for.
 *
 * What that costs is the in-process guarantee, and these fix what replaces it:
 * the file is claimed atomically, so two applies cannot both get it.
 */
const root = () => mkdtempSync(join(tmpdir(), "jam-plan-store-"));

const plan = (overrides: Partial<NewWritePlan> = {}): NewWritePlan =>
  ({
    kind: "existing-issue",
    issueKey: "PROJECT-1",
    issueId: "10001",
    projectKey: "PROJECT",
    operation: "comment.add",
    before: { comments: 0 },
    intendedAfter: { commentAdded: "hello" },
    baseUpdated: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    mutation: { kind: "comment", text: "hello" },
    input: { text: "hello" },
    ...overrides,
  }) as NewWritePlan;

describe("a plan outlives the process that made it", () => {
  it("a second store reads what the first wrote", () => {
    const dir = root();
    const created = new WritePlanStore({ root: dir }).create(plan());

    // The point of the change: `jam jira write-apply` is a different process
    // from the one that planned.
    const applied = new WritePlanStore({ root: dir }).take(created.planId);
    expect(applied.planId).toBe(created.planId);
    expect(applied.mutation).toEqual({ kind: "comment", text: "hello" });
  });

  it("only one of two applies gets the plan", () => {
    const dir = root();
    const created = new WritePlanStore({ root: dir }).create(plan());

    const first = new WritePlanStore({ root: dir });
    const second = new WritePlanStore({ root: dir });
    expect(first.take(created.planId).planId).toBe(created.planId);

    // Whoever claimed it owns the apply. For comment.add the alternative is a
    // second comment, which is exactly what single-use exists to prevent.
    expect(() => second.take(created.planId)).toThrowError(
      expect.objectContaining({ code: "JAM_WRITE_PLAN_NOT_FOUND" }) as unknown as Error,
    );
  });

  it("consume leaves nothing behind", () => {
    const dir = root();
    const store = new WritePlanStore({ root: dir });
    const created = store.create(plan());
    store.take(created.planId);
    store.consume(created.planId);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("an expired plan is reported as expired, not as missing", () => {
    const dir = root();
    const store = new WritePlanStore({
      root: dir,
      now: () => new Date("2026-01-01T00:11:00.000Z"),
    });
    const created = store.create(plan({ expiresAt: "2026-01-01T00:10:00.000Z" }));
    try {
      store.take(created.planId);
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as JamError).code).toBe("JAM_WRITE_PLAN_EXPIRED");
    }
  });

  it("a planId cannot name a file outside the store", () => {
    const store = new WritePlanStore({ root: root() });
    // Not a path traversal test for its own sake: planId reaches this from a
    // command line now, so it has to be a name rather than a path.
    expect(() => store.take("../../etc/passwd")).toThrowError(
      expect.objectContaining({ code: "JAM_WRITE_PLAN_NOT_FOUND" }) as unknown as Error,
    );
  });

  it("what is written is the plan, and it is readable as one", () => {
    const dir = root();
    const created = new WritePlanStore({ root: dir }).create(plan());
    const [file] = readdirSync(dir);
    const onDisk = JSON.parse(readFileSync(join(dir, file as string), "utf8")) as {
      planId: string;
      input: unknown;
    };
    // `input` is what apply re-derives from - see apply-write.ts. A plan
    // without it could not be checked against itself.
    expect(onDisk.planId).toBe(created.planId);
    expect(onDisk.input).toEqual({ text: "hello" });
  });

  it("leftovers that are not plans are cleared rather than accumulated", () => {
    const dir = root();
    writeFileSync(join(dir, "not-a-plan.json"), "{ broken", "utf8");
    new WritePlanStore({ root: dir }).create(plan());
    expect(readdirSync(dir)).toHaveLength(1);
  });
});
