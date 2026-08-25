import type { ContextLevel } from "../domain/completeness.js";
import type { ProjectConfig } from "../config/schema.js";

/**
 * Which tool a given kind of judgement requires. There is no AI intent
 * classifier in this release - the rule is enforced through tool descriptions
 * and project instructions, and this table is the single place it is written down.
 */
export const DEFAULT_CONTEXT_DECISIONS = [
  "readiness",
  "dependency",
  "blocker",
  "priority",
] as const;

export const DEFAULT_FULL_DECISIONS = [
  "agreement",
  "contract",
  "approval",
  "closure",
] as const;

export function minimumLevelFor(decision: string, config: ProjectConfig): ContextLevel {
  const d = decision.trim().toLowerCase();
  if (config.policy.fullRequiredFor.some((x) => x.toLowerCase() === d)) return "full";
  if (config.policy.contextRequiredFor.some((x) => x.toLowerCase() === d)) return "context";
  return "search";
}

/**
 * Human-readable guidance embedded in each tool's description so the model
 * picks the right level without a router.
 */
export const LEVEL_GUIDANCE = {
  search:
    "Listing and discovery only. Results are NOT complete issue context: never conclude agreement, approval, or done-ness from them.",
  context:
    "Readiness, blockers, dependencies and priority. Includes parent/subtasks/links but not the comment thread.",
  full: "Agreement, contract, approval and closure. Includes description and the full comment thread.",
} as const;
