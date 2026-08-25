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

      const source = new WindowsUserEnvCredentialSource(queryFn);
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
});
