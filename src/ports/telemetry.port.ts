export type ToolMetrics = {
  tool: string;
  durationMs: number;
  jiraRequests: number;
  issues: number;
  responseBytes: number;
  pages?: number;
  complete?: boolean;
  errorCode?: string;
};

export interface TelemetryPort {
  recordTool(metrics: ToolMetrics): void;
}
