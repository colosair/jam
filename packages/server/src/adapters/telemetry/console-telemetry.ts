import type { TelemetryPort, ToolMetrics } from "../../ports/telemetry.port.js";

/**
 * One key=value line per tool call on stderr. stdout is reserved for the MCP
 * stdio protocol, so nothing here may ever write to stdout.
 *
 * Only the fields below are emitted - never credentials, headers, JQL bind
 * values, or issue content.
 */
export class ConsoleTelemetry implements TelemetryPort {
  constructor(private readonly enabled: boolean = true) {}

  recordTool(m: ToolMetrics): void {
    if (!this.enabled) return;
    const parts = [
      `tool=${m.tool}`,
      `duration_ms=${Math.round(m.durationMs)}`,
      `jira_requests=${m.jiraRequests}`,
      `issues=${m.issues}`,
      `response_bytes=${m.responseBytes}`,
    ];
    if (m.pages !== undefined) parts.push(`pages=${m.pages}`);
    if (m.complete !== undefined) parts.push(`complete=${m.complete}`);
    if (m.errorCode) parts.push(`error=${m.errorCode}`);
    process.stderr.write(`[jam] ${parts.join(" ")}\n`);
  }
}
