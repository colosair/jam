import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applyWritePlan } from "../../application/apply-write.js";
import type { JamDeps } from "../../deps.js";
import { runTool } from "../tool-result.js";

const DESCRIPTION = `Apply a plan from jira_write_plan. This changes Jira.

Takes a planId and nothing else. The change was decided when the plan was made, so there is no field, payload or override to pass here - that is deliberate, and it is what stops a write happening without the state check that planning did.

Before writing, JAM re-reads the issue and compares it to what the plan saw. If it moved, you get JAM_WRITE_CONFLICT and no write happens: call jira_write_plan again against the new state rather than treating the conflict as a transient failure.

After writing, JAM reads the issue back and checks the intended result is actually there. Only then does it return "applied". Jira accepting a request is not the same as the issue having changed.

Failures worth handling differently:
- JAM_WRITE_CONFLICT             the issue moved; re-plan
- JAM_WRITE_PLAN_EXPIRED         the plan aged out; re-plan
- JAM_WRITE_VERIFICATION_FAILED  Jira accepted it but the issue does not show it; read the issue and tell the user
- JAM_WRITE_UNCERTAIN            JAM does not know whether it landed; read the issue. Do NOT call this tool again - the write may already have been applied, and applying it twice is a second comment or a second transition.

Never report an uncertain or unverified write as done.`;

export function registerJiraWriteApply(server: McpServer, deps: JamDeps): void {
  server.registerTool(
    "jira_write_apply",
    {
      title: "Apply a planned change to a Jira issue (writes)",
      description: DESCRIPTION,
      inputSchema: {
        planId: z
          .string()
          .min(1)
          .describe("The planId returned by jira_write_plan. Single use."),
      },
      // Mutating, but not destructive in the sense hosts warn about: every
      // supported operation adds or changes a field, and none delete anything.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      runTool("jira_write_apply", deps.telemetry, () =>
        applyWritePlan(deps, { planId: args.planId }),
      ),
  );
}
