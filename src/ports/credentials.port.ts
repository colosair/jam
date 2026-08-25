/**
 * Credentials never leave this boundary in any log, telemetry line, or tool
 * result. Only the adapter that builds the HTTP request may read `apiToken`.
 */
export type JiraCredentials = {
  baseUrl: string;
  email: string;
  apiToken: string;
};

export interface CredentialPort {
  load(): JiraCredentials;
  /** Presence check for `jam doctor` - must not return the secret itself. */
  describe(): { baseUrl?: string; email?: string; hasToken: boolean };
}
