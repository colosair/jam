import { JamError } from "../../domain/errors.js";
import type {
  CredentialDescription,
  CredentialPort,
  CredentialSource,
  JiraCredentials,
} from "../../ports/credentials.port.js";
import {
  CREDENTIAL_ENV_KEYS,
  ProcessEnvCredentialSource,
  type CredentialEnvKey,
  type CredentialValueSource,
  type RawCredentialValues,
} from "./process-env.js";
import { SecretStoreCredentialSource } from "./secret-store.js";
import { WindowsUserEnvCredentialSource } from "./windows-user-env.js";

const FIELD_BY_KEY = {
  JIRA_BASE_URL: "baseUrl",
  JIRA_EMAIL: "email",
  JIRA_API_TOKEN: "apiToken",
} as const satisfies Record<CredentialEnvKey, keyof JiraCredentials>;

type NamedSource = { name: Exclude<CredentialSource, "mixed" | "none">; source: CredentialValueSource };

/**
 * Merges credential values field-by-field across sources, in priority order:
 * the current process's own environment, then this user's OS secret store,
 * then the Windows User environment.
 *
 * process.env stays first so a per-session override still behaves as expected,
 * and so CI keeps working unchanged. The secret store comes next because it is
 * the only source an editor launched from a Dock or Start menu can reach - such
 * a process never sourced a shell profile. The Windows User environment stays
 * last: a team member who only ever `setx`'d their token still boots without a
 * fresh terminal.
 *
 * Merging is per field, so a single exported variable can shadow one field of a
 * stored credential and leave the rest - `describe()` reports that as "mixed".
 */
export class CompositeCredentialProvider implements CredentialPort {
  private readonly sources: NamedSource[];
  private cached?: { values: RawCredentialValues; sourceByKey: Partial<Record<CredentialEnvKey, string>> };

  constructor(
    sources: NamedSource[] = [
      { name: "process", source: new ProcessEnvCredentialSource() },
      { name: "secret-store", source: new SecretStoreCredentialSource() },
      { name: "user-env", source: new WindowsUserEnvCredentialSource() },
    ],
  ) {
    this.sources = sources;
  }

  private resolve() {
    if (this.cached) return this.cached;

    const values: RawCredentialValues = {};
    const sourceByKey: Partial<Record<CredentialEnvKey, string>> = {};

    for (const { name, source } of this.sources) {
      const read = source.read();
      for (const key of CREDENTIAL_ENV_KEYS) {
        if (values[key] === undefined && read[key]) {
          values[key] = read[key];
          sourceByKey[key] = name;
        }
      }
    }

    this.cached = { values, sourceByKey };
    return this.cached;
  }

  load(): JiraCredentials {
    const { values } = this.resolve();
    const missing = CREDENTIAL_ENV_KEYS.filter((k) => !values[k]);
    if (missing.length > 0) {
      throw new JamError(
        "CONFIG_INVALID",
        `Missing Jira credentials: ${missing.join(", ")} (checked the process environment, this user's OS secret store, then the Windows User environment). Run \`jam auth login\`.`,
        { missing },
      );
    }

    return {
      baseUrl: values.JIRA_BASE_URL!.replace(/\/+$/, ""),
      email: values.JIRA_EMAIL!,
      apiToken: values.JIRA_API_TOKEN!,
    };
  }

  describe(): CredentialDescription {
    const { values, sourceByKey } = this.resolve();
    const used = new Set(Object.values(sourceByKey));

    let source: CredentialSource = "none";
    if (used.size === 1) source = [...used][0] as CredentialSource;
    else if (used.size > 1) source = "mixed";

    const description: CredentialDescription = { hasToken: Boolean(values.JIRA_API_TOKEN), source };
    if (values.JIRA_BASE_URL) description.baseUrl = values.JIRA_BASE_URL;
    if (values.JIRA_EMAIL) description.email = values.JIRA_EMAIL;
    return description;
  }
}
