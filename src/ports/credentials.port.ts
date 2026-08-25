/**
 * Credentials never leave this boundary in any log, telemetry line, or tool
 * result. Only the adapter that builds the HTTP request may read `apiToken`.
 */
export type JiraCredentials = {
  baseUrl: string;
  email: string;
  apiToken: string;
};

/** Where the resolved credentials came from - "mixed" when fields disagree. */
export type CredentialSource = "process" | "user-env" | "mixed" | "none";

export type CredentialDescription = {
  baseUrl?: string;
  email?: string;
  hasToken: boolean;
  source: CredentialSource;
};

export interface CredentialPort {
  /**
   * Resolve and return credentials, or throw CONFIG_INVALID if a field is
   * missing everywhere it was looked for. Format validation (e.g. the base URL
   * scheme) is not this method's job - that lives in the boot health gate.
   */
  load(): JiraCredentials;
  /** Presence check for `jam doctor` / `jam serve` - must not return the secret itself. */
  describe(): CredentialDescription;
}
