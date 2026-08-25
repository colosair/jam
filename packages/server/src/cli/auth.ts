import { CompositeCredentialProvider } from "../adapters/credentials/composite.js";
import {
  SecretStoreUnavailableError,
  resolveSecretStore,
  type SecretStore,
  type StoredCredentials,
} from "../adapters/credentials/secret-store.js";
import { ProjectConfigSchema } from "../config/schema.js";
import { toJamError } from "../domain/errors.js";
import type { CredentialPort } from "../ports/credentials.port.js";
import { Ui } from "./ui.js";

/**
 * `jam auth login` / `jam auth logout`.
 *
 * Human-facing on purpose: these are the one step of setup an agent must not
 * perform. An agent that asks a person for a token, or stores one, has done
 * something wrong regardless of intent - so this path prompts, and the agent
 * path stops at JAM_AUTH_REQUIRED and hands the user this command.
 *
 * `jam auth status` stays in the agent API: it is presence and origin only,
 * and its JSON shape is a contract.
 */

export type AuthOptions = {
  ui?: Ui;
  /** Injected by tests so the suite never touches a real keychain. */
  store?: SecretStore | undefined;
  /** Reads back what is now in effect. A fresh port each call - see below. */
  readBack?: () => CredentialPort;
  /**
   * Injected by tests. Real verification talks to Jira, which no unit test may
   * do - and the guarantee under test (nothing is stored unless Jira accepted
   * it) is about the ordering, not about the network.
   */
  verify?: (values: StoredCredentials) => Promise<string | undefined>;
};

const TOKEN_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";
const ENV_HINT = "set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN instead";

/**
 * A provider caches its answer for its own lifetime, so the effective source
 * after a write can only be observed through a new one.
 */
function freshPort(): CredentialPort {
  return new CompositeCredentialProvider();
}

export async function authLoginCommand(options: AuthOptions = {}): Promise<number> {
  const ui = options.ui ?? new Ui();
  const store = "store" in options ? options.store : resolveSecretStore();
  const readBack = options.readBack ?? freshPort;

  ui.section("Authentication");

  if (!store) {
    ui.failure("No usable secret store was found on this system");
    ui.line("  JAM stores credentials where the operating system holds them for you,");
    ui.line("  so an editor launched from a Dock or Start menu can still read them.");
    ui.next(`Run:  ${ENV_HINT}`);
    return 1;
  }

  const existing = readBack().describe();
  const baseUrl = trimSlashes(
    await ui.prompt("Jira site URL", ENV_HINT, existing.baseUrl ?? undefined),
  );
  const email = await ui.prompt("Atlassian account email", ENV_HINT, existing.email ?? undefined);
  ui.line(`  Create a token at ${TOKEN_URL}`);
  const apiToken = await ui.secret("Atlassian API token", ENV_HINT);

  const missing = !baseUrl || !email || !apiToken;
  if (missing) {
    ui.failure("Site URL, email and token are all required");
    return 1;
  }
  if (!/^https?:\/\//.test(baseUrl)) {
    ui.failure("The site URL must start with http:// or https://");
    return 1;
  }

  const values: StoredCredentials = { baseUrl, email, apiToken };

  // Verified before it is stored. A rejected token written to the keychain is
  // the worst outcome available here: every later command fails, and the thing
  // that is wrong looks like the thing that was just fixed.
  const verify = options.verify ?? ((v: StoredCredentials) => verifyAgainstJira(ui, v));
  const failure = await verify(values);
  if (failure) {
    ui.line();
    ui.failure("Jira rejected these credentials");
    ui.line(`  ${failure}`);
    ui.line("  Nothing was stored.");
    return 1;
  }

  try {
    store.write(values);
  } catch (err) {
    ui.failure("Could not store the credentials");
    ui.line(`  ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof SecretStoreUnavailableError) ui.next(`Run:  ${err.remedy}`);
    return 1;
  }

  ui.success("Authentication stored", `${email} · ${baseUrl} (${store.label})`);
  reportOverride(ui, readBack());
  return 0;
}

export function authLogoutCommand(options: AuthOptions = {}): number {
  const ui = options.ui ?? new Ui();
  const store = "store" in options ? options.store : resolveSecretStore();
  const readBack = options.readBack ?? freshPort;

  ui.section("Authentication");

  if (!store) {
    ui.warn("No secret store on this system, so there is nothing stored to remove");
    reportRemaining(ui, readBack());
    return 0;
  }

  store.clear();
  ui.success("Removed the stored credentials");
  reportRemaining(ui, readBack());
  return 0;
}

/**
 * Warn when an exported variable shadows what was just stored.
 *
 * The chain merges per field, so this is not "are all three exported" - one
 * stale `export` in a shell profile is enough to make part of the stored
 * credential unreachable, and the resulting split shows up as "mixed".
 */
function reportOverride(ui: Ui, port: CredentialPort): void {
  const source = port.describe().source;
  if (source === "secret-store") return;

  if (source === "mixed") {
    ui.warn("Current JIRA_* environment variables override part of the stored credentials");
  } else {
    ui.warn("Current JIRA_* environment variables override the stored credentials");
  }
  ui.line(`  Effective source: ${source}`);
  ui.line("  Unset them to use what was just stored.");
}

/** After a logout, say plainly whether anything still authenticates JAM. */
function reportRemaining(ui: Ui, port: CredentialPort): void {
  const described = port.describe();
  const stillResolves = Boolean(described.baseUrl && described.email && described.hasToken);

  if (!stillResolves && described.source === "none") {
    ui.line("  JAM is no longer authenticated.");
    return;
  }

  ui.warn(
    stillResolves
      ? "Jira credentials still resolve from outside the secret store"
      : "Part of a Jira credential still resolves from outside the secret store",
  );
  ui.line(`  Effective source: ${described.source}`);
  ui.line("  Unset JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN to finish logging out.");
}

/** undefined when Jira accepted the credentials; otherwise the reason. */
async function verifyAgainstJira(ui: Ui, values: StoredCredentials): Promise<string | undefined> {
  const port: CredentialPort = {
    load: () => values,
    describe: () => ({ baseUrl: values.baseUrl, email: values.email, hasToken: true, source: "process" }),
  };

  try {
    const { JiraCloudReadAdapter } = await import("../adapters/jira-cloud/jira-read.adapter.js");
    const jira = new JiraCloudReadAdapter(port, ProjectConfigSchema.parse({}));
    const me = await ui.spin("Checking Jira access...", () => jira.getCurrentUser());
    ui.success("Jira accepted the credentials", me.displayName ?? me.emailAddress ?? me.accountId);
    return undefined;
  } catch (err) {
    const jamError = toJamError(err);
    return `${jamError.code}: ${jamError.message}`;
  }
}

function trimSlashes(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
