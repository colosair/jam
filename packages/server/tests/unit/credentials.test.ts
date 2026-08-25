import { describe, expect, it } from "vitest";
import { CompositeCredentialProvider } from "../../src/adapters/credentials/composite.js";
import type { CredentialValueSource, RawCredentialValues } from "../../src/adapters/credentials/process-env.js";

const SECRET = "SUPER_SECRET_TOKEN";

class StubSource implements CredentialValueSource {
  constructor(private readonly values: RawCredentialValues) {}
  read(): RawCredentialValues {
    return this.values;
  }
}

describe("CompositeCredentialProvider", () => {
  it("resolves from the second source when the first (process) has nothing", () => {
    const provider = new CompositeCredentialProvider([
      { name: "process", source: new StubSource({}) },
      {
        name: "user-env",
        source: new StubSource({
          JIRA_BASE_URL: "https://example.atlassian.net",
          JIRA_EMAIL: "user@example.com",
          JIRA_API_TOKEN: SECRET,
        }),
      },
    ]);

    expect(provider.load()).toEqual({
      baseUrl: "https://example.atlassian.net",
      email: "user@example.com",
      apiToken: SECRET,
    });
    expect(provider.describe().source).toBe("user-env");
  });

  it("prefers process.env over user-env when both have the same key", () => {
    const provider = new CompositeCredentialProvider([
      { name: "process", source: new StubSource({ JIRA_EMAIL: "from-process@example.com" }) },
      { name: "user-env", source: new StubSource({ JIRA_EMAIL: "from-user-env@example.com" }) },
    ]);

    expect(provider.describe().email).toBe("from-process@example.com");
  });

  it("merges per field and reports 'mixed' when sources disagree on which key they supplied", () => {
    const provider = new CompositeCredentialProvider([
      {
        name: "process",
        source: new StubSource({ JIRA_BASE_URL: "https://example.atlassian.net", JIRA_EMAIL: "user@example.com" }),
      },
      { name: "user-env", source: new StubSource({ JIRA_API_TOKEN: SECRET }) },
    ]);

    const loaded = provider.load();
    expect(loaded.apiToken).toBe(SECRET);
    expect(provider.describe().source).toBe("mixed");
  });

  it("throws CONFIG_INVALID (not a crash) when nothing supplies a required field", () => {
    const provider = new CompositeCredentialProvider([
      { name: "process", source: new StubSource({}) },
      { name: "user-env", source: new StubSource({}) },
    ]);

    expect(() => provider.load()).toThrowError(/CONFIG_INVALID|Missing Jira credentials/);
    expect(provider.describe().source).toBe("none");
  });

  it("resolves from the secret store when nothing is exported", () => {
    // The case D9 exists for: an editor launched from a Dock or Start menu
    // sourced no shell profile, so process.env carries nothing at all.
    const provider = new CompositeCredentialProvider([
      { name: "process", source: new StubSource({}) },
      {
        name: "secret-store",
        source: new StubSource({
          JIRA_BASE_URL: "https://example.atlassian.net",
          JIRA_EMAIL: "user@example.com",
          JIRA_API_TOKEN: SECRET,
        }),
      },
      { name: "user-env", source: new StubSource({}) },
    ]);

    expect(provider.load().apiToken).toBe(SECRET);
    expect(provider.describe().source).toBe("secret-store");
  });

  it("lets an exported value override the secret store", () => {
    const provider = new CompositeCredentialProvider([
      { name: "process", source: new StubSource({ JIRA_EMAIL: "override@example.com" }) },
      { name: "secret-store", source: new StubSource({ JIRA_EMAIL: "stored@example.com" }) },
    ]);

    expect(provider.describe().email).toBe("override@example.com");
  });

  it("reports 'mixed' when an exported value shadows only part of the stored credential", () => {
    // Merging is per field, so one stale export is enough to split the origin.
    // `jam auth login` keys its override warning off exactly this.
    const provider = new CompositeCredentialProvider([
      { name: "process", source: new StubSource({ JIRA_BASE_URL: "https://other.atlassian.net" }) },
      {
        name: "secret-store",
        source: new StubSource({
          JIRA_BASE_URL: "https://example.atlassian.net",
          JIRA_EMAIL: "user@example.com",
          JIRA_API_TOKEN: SECRET,
        }),
      },
    ]);

    expect(provider.describe().source).toBe("mixed");
    expect(provider.describe().baseUrl).toBe("https://other.atlassian.net");
  });

  it("never lets a stored token leak through describe() or JSON serialization", () => {
    const provider = new CompositeCredentialProvider([
      {
        name: "secret-store",
        source: new StubSource({
          JIRA_BASE_URL: "https://example.atlassian.net",
          JIRA_EMAIL: "user@example.com",
          JIRA_API_TOKEN: SECRET,
        }),
      },
    ]);

    provider.load();
    expect(JSON.stringify(provider.describe())).not.toContain(SECRET);
  });

  it("never lets the token leak through describe(), thrown errors, or JSON serialization", () => {
    const provider = new CompositeCredentialProvider([
      {
        name: "user-env",
        source: new StubSource({
          JIRA_BASE_URL: "https://example.atlassian.net",
          JIRA_EMAIL: "user@example.com",
          JIRA_API_TOKEN: SECRET,
        }),
      },
      { name: "process", source: new StubSource({}) },
    ]);

    provider.load();
    const described = provider.describe();
    expect(JSON.stringify(described)).not.toContain(SECRET);

    const partial = new CompositeCredentialProvider([
      { name: "process", source: new StubSource({}) },
      { name: "user-env", source: new StubSource({}) },
    ]);
    let message = "";
    try {
      partial.load();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain(SECRET);
  });
});
