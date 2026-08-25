import { describe, expect, it } from "vitest";
import {
  SecretStoreCredentialSource,
  SecretStoreUnavailableError,
  resolveSecretStore,
  type RunFn,
  type RunResult,
  type SecretStore,
  type StoredCredentials,
} from "../../src/adapters/credentials/secret-store.js";

const SECRET = "SUPER_SECRET_TOKEN";
const stored: StoredCredentials = {
  baseUrl: "https://example.atlassian.net",
  email: "user@example.com",
  apiToken: SECRET,
};

type Call = { command: string; args: string[]; input?: string };

/**
 * Records every command the store would run and answers from a script, so no
 * test ever reaches a real keychain, D-Bus session or DPAPI blob.
 */
function recorder(reply: (call: Call) => Partial<RunResult>) {
  const calls: Call[] = [];
  const run: RunFn = (command, args, input) => {
    const call: Call = { command, args, ...(input === undefined ? {} : { input }) };
    calls.push(call);
    return { status: 0, stdout: "", stderr: "", ...reply(call) };
  };
  return { calls, run };
}

/** Answers the availability probe, then whatever the test scripted. */
function store(reply: (call: Call) => Partial<RunResult>): {
  store: SecretStore;
  calls: Call[];
} {
  const { calls, run } = recorder(reply);
  const resolved = resolveSecretStore(run);
  if (!resolved) throw new Error(`no secret store backend for ${process.platform}`);
  return { store: resolved, calls };
}

const enoent = (): Partial<RunResult> => ({
  status: null,
  error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
});

/** True on the three platforms that have a backend at all. */
const supported = ["darwin", "win32", "linux"].includes(process.platform);

describe.skipIf(!supported)("resolveSecretStore", () => {
  it("returns a store when the platform's backend runs", () => {
    const { run } = recorder(() => ({ status: 0 }));

    expect(resolveSecretStore(run)?.label).toBeTruthy();
  });

  it("returns nothing when the backend is not installed", () => {
    // Being on Linux is not the same as having libsecret; a container or a
    // headless box routinely has neither it nor a session keyring.
    const { run } = recorder(enoent);

    expect(resolveSecretStore(run)).toBeUndefined();
  });
});

describe.skipIf(supported)("resolveSecretStore on an unsupported platform", () => {
  it("returns nothing without probing for a backend", () => {
    const { calls, run } = recorder(() => ({ status: 0 }));

    expect(resolveSecretStore(run)).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe.skipIf(!supported)("SecretStore", () => {
  it("round-trips what was written", () => {
    const written: string[] = [];
    const { store: s } = store((call) => {
      // Whichever backend this platform uses, the payload arrives either on
      // stdin or in argv - capture both and replay it to the reader.
      if (call.input) written.push(call.input);
      const json = call.args.find((a) => a.startsWith("{"));
      if (json) written.push(json);
      return { status: 0, stdout: written[0] ?? "" };
    });

    s.write(stored);
    expect(written[0]).toBeTruthy();
    expect(JSON.parse(written[0]!)).toEqual(stored);
  });

  it("reads nothing when there is no entry", () => {
    const { store: s } = store(() => ({ status: 1, stderr: "not found" }));

    expect(s.read()).toBeUndefined();
  });

  it("reads nothing rather than throwing when the backend fails", () => {
    const { store: s } = store(() => ({ status: 2, stderr: "backend exploded" }));

    expect(() => s.read()).not.toThrow();
    expect(s.read()).toBeUndefined();
  });

  it("treats a corrupt entry as absent", () => {
    const { store: s } = store(() => ({ status: 0, stdout: "{ not json" }));

    expect(s.read()).toBeUndefined();
  });

  it("treats a partial entry as absent", () => {
    const { store: s } = store(() => ({
      status: 0,
      stdout: JSON.stringify({ baseUrl: stored.baseUrl }),
    }));

    expect(s.read()).toBeUndefined();
  });

  it("throws on a failed write, because the user just asked for it", () => {
    const { store: s } = store(() => ({ status: 1, stderr: "denied" }));

    expect(() => s.write(stored)).toThrow();
  });

  it("distinguishes a missing backend from an ordinary write failure", () => {
    // The backend answered the probe, then vanished - the case where a tool is
    // on PATH at startup and uninstalled, or shadowed, by the time it is used.
    let probed = false;
    const { store: s } = store(() => {
      if (!probed) {
        probed = true;
        return { status: 0 };
      }
      return enoent();
    });

    expect(() => s.write(stored)).toThrow(SecretStoreUnavailableError);
    expect(() => s.write(stored)).toThrow(/no usable secret store/i);
  });

  it("clears without complaining when there is nothing to clear", () => {
    const { store: s } = store(() => ({ status: 1, stderr: "not found" }));

    expect(() => s.clear()).not.toThrow();
  });

  it("never puts the secret in its own label", () => {
    const { store: s } = store(() => ({ status: 0 }));

    expect(s.label).not.toContain(SECRET);
  });
});

describe("SecretStoreCredentialSource", () => {
  it("reads nothing when this system has no store", () => {
    expect(new SecretStoreCredentialSource(undefined).read()).toEqual({});
  });

  it("reads nothing when the store is empty", () => {
    const empty: SecretStore = { label: "fake", read: () => undefined, write: () => {}, clear: () => {} };

    expect(new SecretStoreCredentialSource(empty).read()).toEqual({});
  });

  it("presents stored credentials under the env-var keys the chain merges on", () => {
    const full: SecretStore = { label: "fake", read: () => stored, write: () => {}, clear: () => {} };

    expect(new SecretStoreCredentialSource(full).read()).toEqual({
      JIRA_BASE_URL: stored.baseUrl,
      JIRA_EMAIL: stored.email,
      JIRA_API_TOKEN: SECRET,
    });
  });
});
