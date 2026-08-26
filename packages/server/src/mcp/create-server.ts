import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "node:module";
import type { JamDeps } from "../deps.js";
import { registerJiraContext } from "./tools/jira-context.tool.js";
import { registerJiraFull } from "./tools/jira-full.tool.js";
import { registerJiraSearch } from "./tools/jira-search.tool.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version?: string };

export const SERVER_NAME = "jam";

/**
 * The external contract: exactly three read tools, stable from the first
 * release. Internal changes (cache, Rovo, remote transport) must not add or
 * rename anything here.
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
      ].join("\n"),
    },
  );

  registerJiraSearch(server, deps);
  registerJiraContext(server, deps);
  registerJiraFull(server, deps);

  return server;
}
