import { JamError } from "../../domain/errors.js";
import type { CredentialPort, JiraCredentials } from "../../ports/credentials.port.js";

const REQUIRED = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] as const;

/**
 * First-release credential source: environment variables.
 * Swapping in OAuth later means writing a new CredentialPort, nothing else.
 */
export class EnvCredentials implements CredentialPort {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  load(): JiraCredentials {
    const missing = REQUIRED.filter((k) => !this.env[k]?.trim());
    if (missing.length > 0) {
      throw new JamError(
        "CONFIG_INVALID",
        `Missing Jira credentials in environment: ${missing.join(", ")}`,
        { missing },
      );
    }

    const baseUrl = this.env.JIRA_BASE_URL!.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(baseUrl)) {
      throw new JamError(
        "CONFIG_INVALID",
        "JIRA_BASE_URL must start with http:// or https://",
      );
    }

    return {
      baseUrl,
      email: this.env.JIRA_EMAIL!.trim(),
      apiToken: this.env.JIRA_API_TOKEN!.trim(),
    };
  }

  /** Presence only - the token value is never returned or logged. */
  describe(): { baseUrl?: string; email?: string; hasToken: boolean } {
    return {
      baseUrl: this.env.JIRA_BASE_URL?.trim() || undefined,
      email: this.env.JIRA_EMAIL?.trim() || undefined,
      hasToken: Boolean(this.env.JIRA_API_TOKEN?.trim()),
    };
  }
}
