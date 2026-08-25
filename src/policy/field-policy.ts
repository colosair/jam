import type { ProjectConfig } from "../config/schema.js";
import type { ContextLevel } from "../domain/completeness.js";

/**
 * The agent never chooses Jira fields. Each context level has a fixed field set
 * so a discovery call cannot accidentally drag description/comments into the
 * model's context, and `fields=*` is impossible by construction.
 */

/** Never requested at SEARCH level - these are the expensive ones. */
export const HEAVY_FIELDS = ["description", "comment", "attachment", "changelog"] as const;

export function fieldsFor(level: ContextLevel, config: ProjectConfig): string[] {
  const lite = dedupe(config.fields.lite.filter((f) => !isHeavy(f)));
  if (level === "search") return lite;

  const contextFields = dedupe([
    ...lite,
    ...config.fields.context.filter((f) => !isHeavy(f)),
    ...config.customFields.map((cf) => cf.id),
  ]);
  if (level === "context") return contextFields;

  return dedupe([...contextFields, "description", "comment"]);
}

export function isHeavy(field: string): boolean {
  return (HEAVY_FIELDS as readonly string[]).includes(field);
}

function dedupe(fields: string[]): string[] {
  return [...new Set(fields.map((f) => f.trim()).filter(Boolean))];
}
