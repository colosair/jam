import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildDeps } from "../deps.js";
import { createServer } from "./create-server.js";

/**
 * stdout belongs to the MCP protocol. Everything human-readable - telemetry,
 * warnings, errors - goes to stderr, or the transport breaks.
 */
export async function serve(): Promise<void> {
  const deps = await buildDeps();
  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `[jam] serving on stdio (project=${deps.config.project.key || "unset"}, config=${deps.configPath ?? "defaults"})\n`,
  );
}
