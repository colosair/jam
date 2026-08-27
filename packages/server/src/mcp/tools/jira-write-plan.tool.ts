import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { planWrite } from "../../application/plan-write.js";
import type { JamDeps } from "../../deps.js";
import { CREATABLE_FIELDS, WRITABLE_FIELDS, WRITE_OPERATIONS } from "../../domain/write.js";
import { runTool } from "../tool-result.js";

const DESCRIPTION = `Work out how to change one Jira issue, and get back a plan. Changes nothing.

This is the first half of every write. Call it, read what it says the issue looks like now and what it would become, then pass the returned planId to jira_write_apply. There is no way to write to Jira without a plan, and a plan cannot be assembled by hand - only jira_write_plan issues one.

Operations on an issue that already exists - these need \`key\`:
- comment.add        input: { "text": "..." }        plain text; JAM converts it, do not send ADF
- field.update       input: { "summary"?, "priority"?, "labels"?, "components"? }
- status.transition  input: { "status": "Done" }     JAM asks Jira which transitions exist and matches yours
- assignee.update    input: { "assignee": "..." }     a display name or an accountId; JAM resolves it against Jira's own directory

Creating an issue - no \`key\`, because there is no issue yet:
- issue.create       input: { "issueType": "Task", "summary": "...", "description"?, "priority"?, "labels"?, "components"? }

issue.create goes into the project this workspace is bound to; the project is not a parameter. Planning reads Jira's create schema for that project first, so an issue type Jira does not offer, a priority or component outside its allowed values, and a project whose create screen requires a field JAM cannot set are all refused here rather than attempted. \`description\` is plain text, like a comment. Not settable in this version: assignee, reporter, parent, custom fields, attachments.

assignee.update never sends the name you pass. JAM searches Jira's user directory, and assigns only when exactly one user matches your string exactly - an exact display name (case-insensitive) or an accountId. A partial match is Jira reporting a similarity, not identifying a person, so several matches or none come back as a refusal with the candidates attached: name one exactly, or pass their accountId. JAM also checks Jira offers that person as an assignee for this issue, before planning and again before writing, and confirms the result by accountId rather than by name. Unassigning, and setting an assignee while creating, are not in this version.

Writes are limited to the Jira project this workspace is bound to; a key from another project is refused rather than attempted.

The plan records what the issue looked like when it was made, and expires. If the issue changes in the meantime, jira_write_apply refuses with JAM_WRITE_CONFLICT - re-plan against the new state rather than forcing the old one through.

A plan is a statement about what is possible right now, not a promise that it will happen. Nothing is written until jira_write_apply runs.`;

export function registerJiraWritePlan(server: McpServer, deps: JamDeps): void {
  server.registerTool(
    "jira_write_plan",
    {
      title: "Plan a change to a Jira issue (writes nothing)",
      description: DESCRIPTION,
      inputSchema: {
        // Optional at the schema level because issue.create has no issue to
        // name. Every other operation requires it, and planning refuses one
        // that arrives without it - so the schema says "sometimes", and the
        // server says which times.
        key: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Issue key, e.g. "PROJECT-123". Required for every operation that changes an existing issue; omit for issue.create, which has no issue yet. Must be in the configured project.',
          ),
        operation: z
          .enum(WRITE_OPERATIONS)
          .describe(`What to do: ${WRITE_OPERATIONS.join(", ")}.`),
        // Loose, not stripping. A strict object would refuse an unknown field
        // with a schema error, and the default stripping one would silently
        // drop it - which is worse: an agent that asked to set an assignee
        // would get an issue without one and a receipt that never mentions it.
        // Letting unknown keys through means JAM refuses them itself, by name,
        // with the supported list attached.
        input: z
          .looseObject({
            text: z.string().min(1).optional().describe("comment.add: the comment, as plain text."),
            status: z
              .string()
              .min(1)
              .optional()
              .describe("status.transition: the status to move to, e.g. \"Done\"."),
            assignee: z
              .string()
              .min(1)
              .optional()
              .describe(
                "assignee.update: who to assign, as an exact display name or an accountId. Not settable through field.update.",
              ),
            issueType: z
              .string()
              .min(1)
              .optional()
              .describe(
                'issue.create: the issue type by name, e.g. "Task". Matched against the types Jira offers for this project.',
              ),
            description: z
              .string()
              .optional()
              .describe("issue.create: the description, as plain text. JAM converts it; do not send ADF."),
            summary: z.string().min(1).optional(),
            priority: z.string().min(1).optional().describe('Priority name, e.g. "High".'),
            labels: z.array(z.string()).optional().describe("Replaces the whole label set."),
            components: z
              .array(z.string())
              .optional()
              .describe("Component names. Replaces the whole component set."),
          })
          .describe(
            `Operation input. field.update accepts only ${WRITABLE_FIELDS.join(", ")}; issue.create accepts only ${CREATABLE_FIELDS.join(", ")}. Custom fields are not writable by either, and the assignee is changed through assignee.update rather than through field.update.`,
          ),
      },
      // Planning reads Jira and decides; it never mutates. Hosts are free to
      // run it without asking, which is what keeps the two-step shape cheap.
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      runTool("jira_write_plan", deps.telemetry, async () => {
        const { receipt } = await planWrite(deps, {
          ...(args.key !== undefined ? { key: args.key } : {}),
          operation: args.operation,
          input: args.input as Record<string, unknown>,
        });
        return receipt;
      }),
  );
}
