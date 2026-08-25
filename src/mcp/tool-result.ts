import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toJamError } from "../domain/errors.js";
import type { TelemetryPort } from "../ports/telemetry.port.js";

/** Compact JSON - indentation is pure token cost on this path. */
export function ok(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export function fail(err: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(toJamError(err).toPayload()) }],
  };
}

/**
 * Every tool goes through here so a thrown Jira error becomes a normalized code
 * instead of a stack trace, and failures still show up in telemetry.
 */
export async function runTool(
  tool: string,
  telemetry: TelemetryPort,
  fn: () => Promise<unknown>,
): Promise<CallToolResult> {
  const started = performance.now();
  try {
    return ok(await fn());
  } catch (err) {
    const jamError = toJamError(err);
    telemetry.recordTool({
      tool,
      durationMs: performance.now() - started,
      jiraRequests: 0,
      issues: 0,
      responseBytes: 0,
      errorCode: jamError.code,
    });
    return fail(jamError);
  }
}
