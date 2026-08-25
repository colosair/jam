import { JamError } from "../../domain/errors.js";
import type { JiraWritePort } from "../../ports/jira-write.port.js";

/**
 * Deliberate stub. The first release is read-only; the existing Atlassian MCP
 * remains the write path. The port exists so adding writes later is an adapter
 * swap rather than an application-layer change.
 */
export class UnsupportedJiraWriteAdapter implements JiraWritePort {
  async updateIssue(): Promise<void> {
    throw notSupported();
  }

  async addComment(): Promise<{ id: string }> {
    throw notSupported();
  }
}

function notSupported(): JamError {
  return new JamError(
    "CONFIG_INVALID",
    "JAM is read-only in this release. Use the Atlassian MCP for Jira writes.",
  );
}
