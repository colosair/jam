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
export type CredentialSource = "process" | "secret-store" | "user-env" | "mixed" | "none";

export type CredentialDescription = {
  baseUrl?: string;
  email?: string;
  hasToken: boolean;
  source: CredentialSource;
  /**
   * Which source supplied each field. `source` alone says "mixed" without
   * saying mixed how, which reads as a fault when it is a normal state - a
   * base URL and email in the OS store with the token exported for one shell
   * is a supported setup. Names only: no value ever appears here.
   */
  sources?: Partial<Record<"JIRA_BASE_URL" | "JIRA_EMAIL" | "JIRA_API_TOKEN", Exclude<CredentialSource, "mixed" | "none">>>;
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
