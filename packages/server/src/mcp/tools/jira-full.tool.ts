import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getFullIssueContext } from "../../application/get-full-issue-context.js";
import type { JamDeps } from "../../deps.js";
import { runTool } from "../tool-result.js";

const DESCRIPTION = `Get the complete record for one or more Jira issues, including the description and the full comment thread.

Use for final judgements: was this agreed, is the contract settled, was it approved, can it be closed, what did the other team actually answer, what does this issue mean right now.

Returns everything jira_context returns - issueId and statusCategory included - plus description and every comment (normalized to plain text). This is the most expensive tool - prefer jira_search for listing and jira_context for readiness, and reach for this one when the answer must not be wrong.

Ask for as few keys as possible: with several issues at once the output budget may drop the oldest comments. Always check meta.commentsComplete and meta.complete - if either is false, the thread you are reading is partial and a "yes, it is agreed" answer is not supported.

This is the Jira-recorded evidence relevant to agreement, contract, approval and closure. Repository and external sources are not evaluated.

Absence of evidence in Jira is not evidence of absence. A complete read with no supporting comments proves only what Jira holds. If the issue references an external canonical source (an MR/PR, a spec or contract document, Confluence, another issue), do not conclude "not agreed", "not approved" or "cannot start": check that source if you can reach it, and otherwise report that Jira alone cannot settle the question and name the source that must be checked. Issues that reference no external source do not warrant an open-ended search.`;

export function registerJiraFull(server: McpServer, deps: JamDeps): void {
  server.registerTool(
    "jira_full",
    {
      title: "Full Jira issue record (description + comments)",
      description: DESCRIPTION,
      inputSchema: {
        issueKeys: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            'Issue keys, e.g. ["PROJECT-97"]. Keep the list short - the full record is large.',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool("jira_full", deps.telemetry, () =>
        getFullIssueContext(deps, { issueKeys: args.issueKeys }),
      ),
  );
}
