import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getIssueContext } from "../../application/get-issue-context.js";
import type { JamDeps } from "../../deps.js";
import { runTool } from "../tool-result.js";

const DESCRIPTION = `Get the dependency and readiness picture for one or more Jira issues.

Use for: "can I start this", "what is blocking it", "what should I do first", parent/subtask structure, cross-team dependencies, priority ordering.

Returns everything jira_search returns plus issue type, parent, subtasks, issue links (with blocksThisIssue flagged) and the project's whitelisted custom fields. It does NOT return the comment thread - if the question is whether something was agreed, approved, or finished, use jira_full instead.

This is the Jira-recorded evidence relevant to readiness, blockers, dependencies and priority - not a readiness verdict. blocksThisIssue reports how Jira words a link; an empty links array means Jira holds no visible link for you, not that nothing blocks the work. Repository and external sources are not evaluated.

Every issue carries issueId, Jira's immutable id, alongside key. The key is the current human- and integration-facing locator and Jira can move it to another issue; issueId is the identity. Record issueId when a reference has to survive. statusCategory is Jira's own machine-readable category for the status - read it instead of matching status text, which is workflow-defined and localized. Parent, subtasks and links carry issueId too, wherever Jira supplies one.

Pass every key you care about in one call; they are fetched in a single batched round trip. Check meta.complete and meta.missingKeys before drawing conclusions.

This is also how a Jira issue key is checked. Asking for an exact key and getting an issue back is a positive resolution: that key names that issue, right now. A key listed in meta.missingKeys resolved to nothing JAM can see - it may not exist, or it may not be visible to this account, and those are indistinguishable from here. Either way it is unusable, and it is NOT evidence that the number is free, unused or reservable. Never synthesize, increment, predict or reserve a Jira issue key; keys are minted by Jira.`;

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
