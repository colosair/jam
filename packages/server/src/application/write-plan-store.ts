import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { JamError } from "../domain/errors.js";
import type { NewWritePlan, WritePlan } from "../domain/write.js";
import { planExpired } from "../policy/write-policy.js";

/**
 * Where a plan lives between planning and applying.
 *
 * It used to live in the server process and nowhere else, and the ADR said why:
 * a signed token needs a signing key from somewhere, and keeping the mutation
 * in memory made forgery impossible rather than merely hard.
 *
 * The same ADR named the condition for revisiting that - "if plans ever need to
 * outlive a process". They do now. `jam jira write-plan` and `jam jira
 * write-apply` are two processes, so an in-memory plan is gone before apply can
 * see it, and a session whose MCP registry is stale has no way to write at all.
 *
 * So a plan is a file under `~/.jam/write-plans/`, shared by both transports.
 * MCP and CLI read the same store, which means a plan made through the tools
 * can be applied from the shell when the tools stop answering - that is the
 * whole point of the change.
 *
 * What replaces the in-process guarantee is in apply, not here: it re-derives
 * the mutation from the plan's own inputs and refuses if the stored mutation
 * disagrees. Editing the file to smuggle a different write requires editing the
 * inputs to match, which is just calling plan again. See apply-write.ts.
 *
 * See docs/decisions/adr-jira-write-plane.md.
 */

/** One plan, one file. The suffix is the claim: see `take`. */
const PENDING = ".json";
const CLAIMED = ".claimed";

export type WritePlanStoreOptions = {
  /** Injected by tests so expiry does not depend on wall-clock timing. */
  now?: () => Date;
  /** Injected by tests so no suite writes into the real `~/.jam`. */
  root?: string;
};

export class WritePlanStore {
  private readonly now: () => Date;
  private readonly root: string;

  constructor(options: WritePlanStoreOptions | (() => Date) = {}) {
    // The old signature took `now` positionally and tests still use it.
    const opts = typeof options === "function" ? { now: options } : options;
    this.now = opts.now ?? (() => new Date());
    this.root = opts.root ?? join(homedir(), ".jam", "write-plans");
  }

  create(plan: NewWritePlan): WritePlan {
    this.evictExpired();
    const stored: WritePlan = { ...plan, planId: randomUUID() } as WritePlan;
    this.ensureRoot();
    const path = this.pathFor(stored.planId, PENDING);
    writeFileSync(path, JSON.stringify(stored), "utf8");
    // Owner-only. A plan names an issue and what would be written to it, and
    // nothing else on the machine needs to read that.
    chmodSync(path, 0o600);
    return stored;
  }

  /**
   * Resolve a plan for applying, and claim it in the same step.
   *
   * The claim is a rename, because two processes can now reach the same plan
   * and `rename` is the only thing here that is atomic. Whoever renames it owns
   * the apply; everyone else sees the file already gone and is told there is no
   * such plan - which is the truth, for them.
   *
   * Reading and then deleting would leave a window between the two, and for
   * `comment.add` that window is a second comment.
   *
   * An expired plan is reported as expired rather than as missing: those are
   * different situations, and telling them apart is the difference between
   * "re-plan" and "you are calling this wrong".
   */
  take(planId: string): WritePlan {
    const pending = this.pathFor(planId, PENDING);
    const claimed = this.pathFor(planId, CLAIMED);
    try {
      renameSync(pending, claimed);
    } catch {
      throw this.notFound(planId);
    }

    let plan: WritePlan;
    try {
      plan = JSON.parse(readFileSync(claimed, "utf8")) as WritePlan;
    } catch {
      // Unreadable is not "someone else has it" - the file is ours now and it
      // is unusable, so retire it rather than leaving it to expire.
      rmSync(claimed, { force: true });
      throw this.notFound(planId);
    }

    if (planExpired(plan.expiresAt, this.now())) {
      rmSync(claimed, { force: true });
      // What to re-plan against differs by plan: an existing issue has a
      // current state, a create has only the project's current create schema.
      // Naming an issue key here for a create would name an issue that has
      // never existed.
      throw new JamError(
        "JAM_WRITE_PLAN_EXPIRED",
        plan.kind === "create-issue"
          ? `This write plan expired at ${plan.expiresAt}. Nothing was created - re-plan against the current create schema for project ${plan.projectKey}.`
          : `This write plan expired at ${plan.expiresAt}. Re-plan against the current state of ${plan.issueKey}.`,
        {
          planId,
          expiresAt: plan.expiresAt,
          ...(plan.kind === "create-issue"
            ? { project: plan.projectKey }
            : { issueKey: plan.issueKey }),
        },
      );
    }
    return plan;
  }

  /**
   * Retire a plan once it has been applied.
   *
   * Single use, so a receipt cannot be turned into a second mutation by
   * calling apply again with the same id - which for `comment.add` would mean
   * two comments. `take` already made that true by claiming the file; this
   * removes the claim so it does not sit until expiry.
   */
  consume(planId: string): void {
    rmSync(this.pathFor(planId, CLAIMED), { force: true });
  }

  private notFound(planId: string): JamError {
    return new JamError(
      "JAM_WRITE_PLAN_NOT_FOUND",
      "No such write plan. A plan is single-use and expires - call jira_write_plan (or `jam jira write-plan`) again.",
      { planId },
    );
  }

  /** `<planId><suffix>`, with the id checked so it can only name a file here. */
  private pathFor(planId: string, suffix: string): string {
    if (!/^[0-9a-fA-F-]{1,64}$/.test(planId)) {
      throw this.notFound(planId);
    }
    return join(this.root, `${planId}${suffix}`);
  }

  private ensureRoot(): void {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  /**
   * Drop what has aged out, including claims abandoned by a process that died
   * mid-apply. Not retrying such a claim is deliberate: apply may already have
   * reached Jira, and that is `JAM_WRITE_UNCERTAIN`'s whole posture.
   */
  private evictExpired(): void {
    if (!existsSync(this.root)) return;
    const now = this.now();
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith(PENDING) && !name.endsWith(CLAIMED)) continue;
      const path = join(this.root, name);
      try {
        const plan = JSON.parse(readFileSync(path, "utf8")) as WritePlan;
        if (planExpired(plan.expiresAt, now)) rmSync(path, { force: true });
      } catch {
        // Unparseable leftovers are not plans. Removing them keeps the
        // directory from growing without bound, and nothing is lost: a plan
        // that cannot be read cannot be applied either.
        rmSync(path, { force: true });
      }
    }
  }
}
