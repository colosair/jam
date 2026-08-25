export const CREDENTIAL_ENV_KEYS = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"] as const;
export type CredentialEnvKey = (typeof CREDENTIAL_ENV_KEYS)[number];
export type RawCredentialValues = Partial<Record<CredentialEnvKey, string>>;

/** A named source of raw credential values, keyed by env var name. */
export interface CredentialValueSource {
  read(): RawCredentialValues;
}

/** Reads the current process's own environment. Always tried first. */
export class ProcessEnvCredentialSource implements CredentialValueSource {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  read(): RawCredentialValues {
    const out: RawCredentialValues = {};
    for (const key of CREDENTIAL_ENV_KEYS) {
      const value = this.env[key]?.trim();
      if (value) out[key] = value;
    }
    return out;
  }
}
