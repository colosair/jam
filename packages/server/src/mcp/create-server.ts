import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "node:module";
import type { JamDeps } from "../deps.js";
import { registerJiraContext } from "./tools/jira-context.tool.js";
import { registerJiraFull } from "./tools/jira-full.tool.js";
import { registerJiraSearch } from "./tools/jira-search.tool.js";
import { registerJiraWriteApply } from "./tools/jira-write-apply.tool.js";
import { registerJiraWritePlan } from "./tools/jira-write-plan.tool.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version?: string };

export const SERVER_NAME = "jam";

/**
 * The external contract: three read tools and two write tools.
 *
 * The read three have been stable since the first release and do not change.
 * The write pair is a single operation split in half on purpose - deciding and
 * doing are separate calls, so an agent cannot mutate Jira without first
 * having been shown what it is about to change. Internal changes (cache, Rovo,
 * remote transport) must not add or rename anything here.
 */
export function createServer(deps: JamDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: pkg.version ?? "0.0.0" },
    {
      instructions: [
        "JAM (Jira Agent MCP) is the default path for reading Jira.",
        "Pick the tool by what the answer will be used for:",
        "- listing / discovery / current status -> jira_search",
        "- readiness, blockers, dependencies, priority -> jira_context",
        "- agreement, contract, approval, closure -> jira_full",
        "Never treat a jira_search result as complete issue context.",
        "Every result carries a `meta` block; if meta.complete is false the answer is partial and must be reported as such.",
        "meta.complete describes JAM's retrieval, not the project: it means the Jira read finished with no known loss, never that Jira holds the whole story.",
        "meta.evidenceScope and meta.limitations name what was not evaluated - the repository and every external source among them. Judge Jira evidence from these results; judge execution reality elsewhere.",
        "",
        "Writing Jira is two steps: jira_write_plan, then jira_write_apply with the planId it returned.",
        "jira_write_plan changes nothing - it reads the issue, checks the change is possible, and describes what would happen.",
        "jira_write_apply takes only a planId. There is no way to write without planning first, and no payload to override what the plan decided.",
        "Writes are confined to the configured Jira project, and confirmed by reading the issue back. A write JAM could not verify is never reported as done.",
        "On JAM_WRITE_CONFLICT or JAM_WRITE_PLAN_EXPIRED, plan again against the current state. On JAM_WRITE_UNCERTAIN, read the issue - never retry the apply, which could apply the change twice.",
      ].join("\n"),
    },
  );

  registerJiraSearch(server, deps);
  registerJiraContext(server, deps);
  registerJiraFull(server, deps);
  registerJiraWritePlan(server, deps);
  registerJiraWriteApply(server, deps);

  return server;
}
