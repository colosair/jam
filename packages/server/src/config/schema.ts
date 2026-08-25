import { z } from "zod";

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
   */
  customFields: z
    .array(
      z.object({
        id: z.string().regex(/^customfield_\d+$/),
        name: z.string().min(1),
      }),
    )
    .default([]),

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
