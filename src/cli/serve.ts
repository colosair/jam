import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootstrapForServe, type BootstrapForServeOptions } from "../bootstrap/bootstrap-orchestrator.js";
import { createServer } from "../mcp/create-server.js";

/**
 * stdout is reserved for the MCP protocol - every diagnostic here goes to
 * stderr. A failed boot gate means the server never calls `connect()`: a
 * half-started MCP is worse than a clear failure message and a non-zero exit.
 */
export async function serve(options: BootstrapForServeOptions = {}): Promise<number> {
  const { deps, gate } = await bootstrapForServe(options);

  if (!gate.passed) {
    process.stderr.write("[jam] boot check failed - MCP server not started:\n");
    for (const check of gate.checks.filter((c) => c.fatal && !c.ok)) {
      process.stderr.write(`  [FAIL] ${check.name}${check.detail ? ` - ${check.detail}` : ""}\n`);
    }
    process.stderr.write("Run `jam setup` to fix configuration, or `jam doctor` for the full diagnosis.\n");
    return 1;
  }

  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `[jam] serving on stdio (project=${deps.config.project.key || "unset"}, config=${deps.configPath ?? "generated"})\n`,
  );
  return -1; // stays alive on the stdio transport
}
