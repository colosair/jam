import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { SecretStore, StoredCredentials } from "../../src/adapters/credentials/secret-store.js";
import { runSetupWizard, type WizardOptions } from "../../src/cli/setup-wizard.js";
import { Ui } from "../../src/cli/ui.js";
import type { CredentialDescription, CredentialPort } from "../../src/ports/credentials.port.js";
import { FakeJira } from "../helpers.js";

const SECRET = "SUPER_SECRET_TOKEN";
const BASE_URL = "https://example.atlassian.net";
const EMAIL = "user@example.com";

const stored: StoredCredentials = { baseUrl: BASE_URL, email: EMAIL, apiToken: SECRET };

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A project root with a runtime already chosen, so runtime never blocks. */
function fixture(): { cwd: string; home: string } {
  const cwd = tmp("jam-wizard-");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const home = tmp("jam-home-");
  mkdirSync(join(home, ".jam"), { recursive: true });
  writeFileSync(join(home, ".jam", "config.yaml"), "version: 1\nruntime:\n  mode: package\n", "utf8");
  return { cwd, home };
}

function captureStream(): NodeJS.WriteStream & { text: () => string } {
  const chunks: string[] = [];
  const stream = new PassThrough() as unknown as NodeJS.WriteStream & { text: () => string };
  (stream as unknown as { isTTY: boolean }).isTTY = true;
  const original = stream.write.bind(stream);
  stream.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return original(chunk);
  }) as typeof stream.write;
  stream.text = () => chunks.join("");
  return stream;
}

function fakeInput(): NodeJS.ReadStream {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  (input as unknown as { isTTY: boolean }).isTTY = true;
  return input;
}

async function answer(input: NodeJS.ReadStream, lines: string[]): Promise<void> {
  for (const value of lines) {
    await new Promise((r) => setImmediate(r));
    (input as unknown as { write: (chunk: string) => void }).write(`${value}\r`);
  }
  await new Promise((r) => setImmediate(r));
}

const absent: CredentialDescription = { hasToken: false, source: "none" };
const present: CredentialDescription = {
  baseUrl: BASE_URL,
  email: EMAIL,
  hasToken: true,
  source: "secret-store",
};

/**
 * A credential port that answers differently once the store has been written -
 * exactly what the machine does across a successful `jam auth login`, and the
 * only way to tell a re-detect from a reused snapshot.
 */
function switchingCredentials(store: { held?: StoredCredentials }): CredentialPort {
  return {
    load: () => {
      if (!store.held) throw new Error("no credentials");
      return store.held;
    },
    describe: () => (store.held ? present : absent),
  };
}

function fakeStore(): SecretStore & { held?: StoredCredentials; writes: number } {
  let held: StoredCredentials | undefined;
  let writes = 0;
  return {
    label: "fake store",
    read: () => held,
    write(values) {
      writes += 1;
      held = values;
    },
    clear() {
      held = undefined;
    },
    get held() {
      return held;
    },
    get writes() {
      return writes;
    },
  } as SecretStore & { held?: StoredCredentials; writes: number };
}

/** Everything external pinned: no keychain, no Jira, no ambient env. */
function options(over: Partial<WizardOptions> = {}): WizardOptions {
  const { cwd, home } = fixture();
  return {
    cwd,
    home,
    explicitKey: "PROJECT",
    env: {},
    jira: new FakeJira({ pages: [{ issues: [], responseBytes: 0 }] }),
    ...over,
  };
}

describe("wizard credentials step", () => {
  it("re-detects after a successful login, so later steps see the new credentials", async () => {
    const stream = captureStream();
    const input = fakeInput();
    const store = fakeStore();
    const credentials = switchingCredentials(store);

    const run = runSetupWizard(
      options({
        ui: new Ui({ stream, input, color: false, interactive: true }),
        credentials,
        auth: { store, verify: async () => undefined, readBack: () => credentials },
      }),
    );
    await answer(input, [BASE_URL, EMAIL, SECRET]);
    await run;

    expect(store.writes).toBe(1);
    // This line is rendered from the state returned by the credentials step.
    // The pre-login snapshot said "not configured", so it can only appear if
    // that step looked again after the login instead of reusing it.
    const out = stream.text();
    expect(out).toMatch(/Jira credentials found\s+user@example\.com/);
    expect(out).toMatch(/secret-store/);
    expect(out).not.toContain(SECRET);
  });

  it("keeps going without a refresh when the login fails", async () => {
    const stream = captureStream();
    const input = fakeInput();
    const store = fakeStore();
    const credentials = switchingCredentials(store);

    const run = runSetupWizard(
      options({
        ui: new Ui({ stream, input, color: false, interactive: true }),
        credentials,
        auth: {
          store,
          verify: async () => "JIRA_AUTH_FAILED: rejected",
          readBack: () => credentials,
        },
      }),
    );
    await answer(input, [BASE_URL, EMAIL, SECRET]);
    const code = await run;

    expect(store.writes).toBe(0);
    expect(code).not.toBe(0);
    expect(stream.text()).toMatch(/Jira rejected these credentials/);
    expect(stream.text()).not.toContain(SECRET);
  });

  it("never opens a prompt without a terminal", async () => {
    const stream = captureStream();
    const store = fakeStore();

    const code = await runSetupWizard(
      options({
        ui: new Ui({ stream, input: fakeInput(), color: false, interactive: false }),
        credentials: switchingCredentials(store),
        auth: {
          store,
          verify: async () => {
            throw new Error("verification must not run without a terminal");
          },
        },
      }),
    );

    expect(store.writes).toBe(0);
    expect(code).not.toBe(0);
    expect(stream.text()).toMatch(/Run `jam auth login`/);
  });
});

describe("wizard status menu", () => {
  it("re-authenticates for real rather than printing instructions", async () => {
    // Everything already configured, so the wizard shows the menu instead.
    const { cwd, home } = fixture();
    mkdirSync(join(cwd, ".jira-agent"), { recursive: true });
    writeFileSync(join(cwd, ".jira-agent", "project.yaml"), "version: 1\nproject:\n  key: PROJECT\n", "utf8");
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { jam: { command: "npx", args: [] } } }),
      "utf8",
    );

    const stream = captureStream();
    const input = fakeInput();
    const store = fakeStore();
    store.write(stored);
    const credentials = switchingCredentials(store);
    let loginRan = false;

    const run = runSetupWizard({
      cwd,
      home,
      env: {},
      credentials,
      jira: new FakeJira(),
      ui: new Ui({ stream, input, color: false, interactive: true }),
      auth: {
        store,
        readBack: () => credentials,
        verify: async () => {
          loginRan = true;
          return undefined;
        },
      },
    });

    // Menu: down twice to "Re-authenticate", then Enter.
    await new Promise((r) => setImmediate(r));
    (input as unknown as { write: (c: string) => void }).write("[B[B\r");
    await answer(input, [BASE_URL, EMAIL, SECRET]);
    await run;

    expect(loginRan).toBe(true);
    expect(stream.text()).not.toMatch(/Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN, then run/);
    expect(stream.text()).not.toContain(SECRET);
  });
});
