import { describe, expect, it } from "vitest";
import { WindowsUserEnvCredentialSource, type RegQueryFn } from "../../src/adapters/credentials/windows-user-env.js";

describe("WindowsUserEnvCredentialSource", () => {
  it.skipIf(process.platform !== "win32")(
    "queries each credential var individually and skips misses",
    () => {
      const calls: string[] = [];
      const queryFn: RegQueryFn = (name) => {
        calls.push(name);
        if (name === "JIRA_BASE_URL") return "https://example.atlassian.net";
        if (name === "JIRA_EMAIL") return "user@example.com";
        return undefined; // JIRA_API_TOKEN not set in the registry, say
      };

      // Empty env on purpose: the suite sets JAM_DISABLE_USER_ENV, and this
      // case is about what the source reads when it is switched on.
      const source = new WindowsUserEnvCredentialSource(queryFn, {});
      const values = source.read();

      expect(calls.sort()).toEqual(["JIRA_API_TOKEN", "JIRA_BASE_URL", "JIRA_EMAIL"]);
      expect(values).toEqual({
        JIRA_BASE_URL: "https://example.atlassian.net",
        JIRA_EMAIL: "user@example.com",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "returns nothing on non-Windows platforms without ever calling the query function",
    () => {
      let called = false;
      const source = new WindowsUserEnvCredentialSource(() => {
        called = true;
        return "should-not-be-read";
      });

      expect(source.read()).toEqual({});
      expect(called).toBe(false);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "reads nothing, and asks the registry nothing, when JAM_DISABLE_USER_ENV is set",
    () => {
      // HKCU\Environment is per-user, not per-HOME. Without this switch a
      // sandbox that repoints HOME still sees whatever the developer running
      // the suite once `setx`'d, so a hermetic test would pass or fail
      // depending on whose machine ran it.
      let called = false;
      const source = new WindowsUserEnvCredentialSource(
        () => {
          called = true;
          return "should-not-be-read";
        },
        { JAM_DISABLE_USER_ENV: "1" },
      );

      expect(source.read()).toEqual({});
      expect(called).toBe(false);
    },
  );

  it("is switched off for this suite, so a developer machine reads like CI", () => {
    // The seam is only worth having if the suite actually uses it: this pins
    // that tests/setup-env.ts set it, on every platform.
    expect(process.env["JAM_DISABLE_USER_ENV"]).toBe("1");
    expect(process.env["JAM_DISABLE_SECRET_STORE"]).toBe("1");
    expect(process.env["JIRA_API_TOKEN"]).toBeUndefined();
  });
});
