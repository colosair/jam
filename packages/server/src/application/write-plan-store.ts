import { randomUUID } from "node:crypto";
import { JamError } from "../domain/errors.js";
import type { NewWritePlan, WritePlan } from "../domain/write.js";
import { planExpired } from "../policy/write-policy.js";

/**
 * Where a plan lives between `jira_write_plan` and `jira_write_apply`.
 *
 * In this process, and nowhere else. The alternative considered was a signed
 * self-contained token, and it is worse here on both counts that matter: the
 * signing key would have to come from somewhere (a new secret on disk, or a
 * per-process key that gives the token exactly this lifetime anyway), and the
 * mutation would have to travel through the agent to come back. Keeping the
 * mutation in memory makes forgery impossible rather than merely hard - a
 * `planId` is an opaque handle, and what it names never leaves this process.
 *
 * The cost is that plans do not survive a restart. That is acceptable: a plan
 * is only valid while the issue has not moved, so a stale one was going to be
 * rejected on its own terms, and re-planning is a single read.
 *
 * See docs/decisions/adr-jira-write-plane.md.
 */
export class WritePlanStore {
  private readonly plans = new Map<string, WritePlan>();

  /** Injected by tests so expiry does not depend on wall-clock timing. */
  constructor(private readonly now: () => Date = () => new Date()) {}

  create(plan: NewWritePlan): WritePlan {
    this.evictExpired();
    const stored: WritePlan = { ...plan, planId: randomUUID() } as WritePlan;
    this.plans.set(stored.planId, stored);
    return stored;
  }

  /**
   * Resolve a plan for applying.
   *
   * An expired plan is reported as expired rather than as missing: those are
   * different situations, and telling them apart is the difference between
   * "re-plan" and "you are calling this wrong".
   */
  take(planId: string): WritePlan {
    const plan = this.plans.get(planId);
    if (!plan) {
      throw new JamError(
        "JAM_WRITE_PLAN_NOT_FOUND",
        "No such write plan. Plans live in the running JAM server and do not survive a restart - call jira_write_plan again.",
        { planId },
      );
    }
    if (planExpired(plan.expiresAt, this.now())) {
      this.plans.delete(planId);
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
   * two comments.
   */
  consume(planId: string): void {
    this.plans.delete(planId);
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [id, plan] of this.plans) {
      if (planExpired(plan.expiresAt, now)) this.plans.delete(id);
    }
  }
}
