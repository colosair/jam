import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchIssues } from "../../application/search-issues.js";
import type { JamDeps } from "../../deps.js";
import { runTool } from "../tool-result.js";

const DESCRIPTION = `Find Jira issues by JQL and get a lightweight list back.

Use for: discovery, listing, "what is open", "what is assigned to me", recent changes, picking candidate issues.

Returns key, summary, status, assignee, priority, updated, labels and components only. It deliberately does NOT return description, comments, attachments or links - that keeps listing cheap.

Because of that, a jira_search result is NOT complete issue context. Never conclude from it that something is agreed, approved, unblocked, or done. Follow up with jira_context (readiness, blockers, dependencies, priority) or jira_full (agreement, contract, approval, closure).

scope="preview" (default) returns the first page for interactive exploration. scope="complete" walks every page - use it whenever the answer depends on the total count or on seeing every match. Check meta.complete before treating the list as exhaustive.`;

export function registerJiraSearch(server: McpServer, deps: JamDeps): void {
  server.registerTool(
    "jira_search",
    {
      title: "Search Jira issues (lightweight list)",
      description: DESCRIPTION,
      inputSchema: {
        jql: z
          .string()
          .min(1)
          .describe(
            'JQL query, e.g. \'project = PROJECT AND statusCategory != Done ORDER BY updated DESC\'.',
          ),
        scope: z
          .enum(["preview", "complete"])
          .optional()
          .describe(
            '"preview" (default) = first page only. "complete" = every page, for exhaustive enumeration or counting.',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool("jira_search", deps.telemetry, () =>
        searchIssues(deps, { jql: args.jql, ...(args.scope ? { scope: args.scope } : {}) }),
      ),
  );
}
