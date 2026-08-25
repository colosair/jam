import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getIssueContext } from "../../application/get-issue-context.js";
import type { JamDeps } from "../../deps.js";
import { runTool } from "../tool-result.js";

const DESCRIPTION = `Get the dependency and readiness picture for one or more Jira issues.

Use for: "can I start this", "what is blocking it", "what should I do first", parent/subtask structure, cross-team dependencies, priority ordering.

Returns everything jira_search returns plus issue type, parent, subtasks, issue links (with blocksThisIssue flagged) and the project's whitelisted custom fields. It does NOT return the comment thread - if the question is whether something was agreed, approved, or finished, use jira_full instead.

Pass every key you care about in one call; they are fetched in a single batched round trip. Check meta.complete and meta.missingKeys before drawing conclusions.`;

export function registerJiraContext(server: McpServer, deps: JamDeps): void {
  server.registerTool(
    "jira_context",
    {
      title: "Jira issue context (dependencies, blockers, readiness)",
      description: DESCRIPTION,
      inputSchema: {
        issueKeys: z
          .array(z.string().min(1))
          .min(1)
          .describe('Issue keys, e.g. ["PROJECT-97", "PROJECT-101"]. Batch them in one call.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool("jira_context", deps.telemetry, () =>
        getIssueContext(deps, { issueKeys: args.issueKeys }),
      ),
  );
}
