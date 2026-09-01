import { z } from "zod";

/** Values that appear more than once, each named once. */
function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function report(ctx: z.RefinementCtx, repeated: string[], what: string): void {
  for (const value of repeated) {
    ctx.addIssue({
      code: "custom",
      message: `duplicate custom field ${what} "${value}" - a selector must name one field`,
    });
  }
}

/**
 * `.jira-agent/project.yaml` - per-project policy only.
 * Credentials are never stored here; they come from the CredentialPort.
 */
export const ProjectConfigSchema = z.object({
  version: z.literal(1).default(1),

  /**
   * Empty key is allowed so `jam serve` still boots without a project.yaml;
   * `jam doctor` is what flags it as unconfigured.
   */
  project: z
    .object({
      key: z.string().default(""),
    })
    .prefault({}),

  search: z
    .object({
      /** Page size sent to Jira. Not the total result count. */
      pageSize: z.number().int().min(1).max(100).default(50),
      /** Safety stop for `scope: "complete"`. Hitting it is reported, never silent. */
      maxPages: z.number().int().min(1).max(200).default(20),
    })
    .prefault({}),

  fields: z
    .object({
      lite: z.array(z.string()).default([
        "summary",
        "status",
        "assignee",
        "priority",
        "updated",
        "labels",
        "components",
      ]),
      context: z
        .array(z.string())
        .default(["parent", "subtasks", "issuelinks", "issuetype"]),
    })
    .prefault({}),

  /**
   * Whitelisted project-specific custom fields, surfaced at CONTEXT level and up.
   * `id` is the Jira field id (customfield_10011); `name` is what the agent sees.
   *
   * `writable` is a second, separate consent. Reading a field and letting an
   * agent change it are different decisions, and a config written when JAM
   * could only read must not start granting writes because JAM learned how.
   * So it defaults to false: every whitelist that predates this is read-only,
   * and a team opts a field in by saying so.
   */
  customFields: z
    .array(
      z.object({
        id: z.string().regex(/^customfield_\d+$/),
        name: z.string().min(1),
        writable: z.boolean().default(false),
      }),
    )
    .default([])
    .superRefine((fields, ctx) => {
      // Ambiguity in a whitelist is worse than an omission: `custom-field.update`
      // resolves a selector against these entries, and two rows answering to
      // the same selector would make which field gets written a matter of
      // ordering.
      report(ctx, duplicates(fields.map((f) => f.id.toLowerCase())), "id");
      report(
        ctx,
        duplicates(fields.filter((f) => f.writable).map((f) => f.name.trim().toLowerCase())),
        "writable name",
      );
    }),

  output: z
    .object({
      /** Rough token ceilings per level. Enforced by OutputBudgetPolicy. */
      searchTokens: z.number().int().min(200).default(2000),
      contextTokens: z.number().int().min(200).default(5000),
      fullTokens: z.number().int().min(200).default(8000),
    })
    .prefault({}),

  policy: z
    .object({
      contextRequiredFor: z
        .array(z.string())
        .default(["readiness", "dependency", "blocker", "priority"]),
      fullRequiredFor: z
        .array(z.string())
        .default(["agreement", "contract", "approval", "closure"]),
    })
    .prefault({}),

  telemetry: z
    .object({
      enabled: z.boolean().default(true),
    })
    .prefault({}),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
