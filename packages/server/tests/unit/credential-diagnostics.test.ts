// Credential provenance, and what "mixed" is allowed to mean.
//
// A base URL and email in the OS store with the token exported for one shell
// is a supported setup, and it reports as `source: "mixed"`. Reading that as a
// fault sent an operator looking for a broken credential that was working -
// so mixed carries per-field sources, and it is only ever a warning. Whether
// the credentials are any good is Jira's answer, on its own axis.

import { describe, expect, it } from "vitest";
import { CompositeCredentialProvider } from "../../src/adapters/credentials/composite.js";
import type { CredentialValueSource } from "../../src/adapters/credentials/process-env.js";

const stub = (values: Record<string, string>): CredentialValueSource => ({
  read: () => values,
});

const BASE = "https://example.atlassian.net";

describe("credential diagnostics - source per field, never a value", () => {
  it("a single source reports itself with per-field provenance", () => {
    const provider = new CompositeCredentialProvider([
      { name: "process", source: stub({ JIRA_BASE_URL: BASE, JIRA_EMAIL: "u@example.com", JIRA_API_TOKEN: "SECRET" }) },
    ]);
    const described = provider.describe();
    expect(described.source).toBe("process");
    expect(described.sources).toEqual({
      JIRA_BASE_URL: "process",
      JIRA_EMAIL: "process",
      JIRA_API_TOKEN: "process",
    });
  });

  it("mixed names which field came from which source", () => {
    const provider = new CompositeCredentialProvider([
      { name: "process", source: stub({ JIRA_API_TOKEN: "SECRET" }) },
      { name: "secret-store", source: stub({ JIRA_BASE_URL: BASE, JIRA_EMAIL: "u@example.com" }) },
    ]);
    const described = provider.describe();
    expect(described.source).toBe("mixed");
    expect(described.sources).toEqual({
      JIRA_BASE_URL: "secret-store",
      JIRA_EMAIL: "secret-store",
      JIRA_API_TOKEN: "process",
    });
    // Mixed is complete: every field resolved, so this is a usable credential.
    expect(described.hasToken).toBe(true);
    expect(described.baseUrl).toBe(BASE);
  });

  it("no description ever carries the token itself", () => {
    const provider = new CompositeCredentialProvider([
      { name: "process", source: stub({ JIRA_BASE_URL: BASE, JIRA_EMAIL: "u@example.com", JIRA_API_TOKEN: "SUPER-SECRET" }) },
    ]);
    expect(JSON.stringify(provider.describe())).not.toContain("SUPER-SECRET");
  });

  it("a missing field leaves that field out rather than guessing a source", () => {
    const provider = new CompositeCredentialProvider([
      { name: "process", source: stub({ JIRA_BASE_URL: BASE }) },
    ]);
    const described = provider.describe();
    expect(described.hasToken).toBe(false);
    expect(described.sources).toEqual({ JIRA_BASE_URL: "process" });
  });
});
