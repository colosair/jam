import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type {
  SecretStore,
  StoredCredentials,
} from "../../src/adapters/credentials/secret-store.js";
import { authLoginCommand, authLogoutCommand, toJiraOrigin } from "../../src/cli/auth.js";
import { Ui } from "../../src/cli/ui.js";
import type { CredentialDescription, CredentialPort } from "../../src/ports/credentials.port.js";

const SECRET = "SUPER_SECRET_TOKEN";
const BASE_URL = "https://example.atlassian.net";
const EMAIL = "user@example.com";

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

/** Answers the site / email / token prompts in order. */
async function answer(input: NodeJS.ReadStream, lines: string[]): Promise<void> {
  for (const value of lines) {
    await new Promise((r) => setImmediate(r));
    (input as unknown as { write: (chunk: string) => void }).write(`${value}\r`);
  }
  await new Promise((r) => setImmediate(r));
}

function fakeStore(initial?: StoredCredentials): SecretStore & { held?: StoredCredentials; writes: number } {
  let held = initial;
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

function port(description: CredentialDescription): CredentialPort {
  return {
    load: () => {
      throw new Error("not needed");
    },
    describe: () => description,
  };
}

const storedOnly: CredentialDescription = {
  baseUrl: BASE_URL,
  email: EMAIL,
  hasToken: true,
  source: "secret-store",
};
const none: CredentialDescription = { hasToken: false, source: "none" };

/** Jira is never contacted from a unit test; ordering is what is under test. */
const accepts = async () => undefined;
const rejects = async () => "JIRA_AUTH_FAILED: rejected";

describe("jam auth login", () => {
  it("refuses, without prompting, when this system has no store", async () => {
    const stream = captureStream();
    const ui = new Ui({ stream, input: fakeInput(), color: false, interactive: true });

    const code = await authLoginCommand({ ui, store: undefined, readBack: () => port(none) });

    expect(code).toBe(1);
    expect(stream.text()).toMatch(/No usable secret store/);
  });

  it("stores the credentials once Jira has accepted them", async () => {
    const stream = captureStream();
    const input = fakeInput();
    const ui = new Ui({ stream, input, color: false, interactive: true });
    const store = fakeStore();

    const run = authLoginCommand({
      ui,
      store,
      verify: accepts,
      readBack: () => port(storedOnly),
    });
    await answer(input, [BASE_URL, EMAIL, SECRET]);

    expect(await run).toBe(0);
    expect(store.held).toEqual({ baseUrl: BASE_URL, email: EMAIL, apiToken: SECRET });
    expect(stream.text()).toMatch(/Authentication stored/);
    expect(stream.text()).not.toContain(SECRET);
  });

  it("stores nothing when Jira rejects the credentials", async () => {
    const stream = captureStream();
    const input = fakeInput();
    const ui = new Ui({ stream, input, color: false, interactive: true });
    const store = fakeStore();

    const run = authLoginCommand({ ui, store, verify: rejects, readBack: () => port(none) });
    await answer(input, [BASE_URL, EMAIL, SECRET]);
    const code = await run;

    expect(code).toBe(1);
    expect(store.writes).toBe(0);
    expect(store.held).toBeUndefined();
    expect(stream.text()).toMatch(/Jira rejected these credentials/);
    expect(stream.text()).toMatch(/Nothing was stored/);
  });

  it("accepts a whole project page URL and stores only its origin", async () => {
    // What people actually paste. Anything past the origin would be appended to
    // every REST path, and Jira would answer with its HTML shell at 200.
    const stream = captureStream();
    const input = fakeInput();
    const ui = new Ui({ stream, input, color: false, interactive: true });
    const store = fakeStore();

    const run = authLoginCommand({ ui, store, verify: accepts, readBack: () => port(storedOnly) });
    await answer(input, [
      "https://example.atlassian.net/jira/software/c/projects/EXAMPLE/summary",
      EMAIL,
      SECRET,
    ]);

    expect(await run).toBe(0);
    expect(store.held?.baseUrl).toBe("https://example.atlassian.net");
  });

  it("gives up on a URL it cannot parse, without asking for anything else", async () => {
    const stream = captureStream();
    const input = fakeInput();
    const ui = new Ui({ stream, input, color: false, interactive: true });
    const store = fakeStore();
    let verified = false;

    const run = authLoginCommand({
      ui,
      store,
      readBack: () => port(none),
      verify: async () => {
        verified = true;
        return undefined;
      },
    });
    // Re-asked, but not forever: three unusable answers end the command.
    await answer(input, ["example.atlassian.net", "also not a url", "still not a url"]);

    expect(await run).toBe(1);
    expect(verified).toBe(false);
    expect(store.writes).toBe(0);
    expect(stream.text()).toMatch(/does not look like a Jira URL/);
    expect(stream.text()).toMatch(/after 3 attempts/);
    expect(stream.text()).not.toContain("Atlassian API token");
  });

  it("re-asks the URL and carries on with the same run", async () => {
    const stream = captureStream();
    const input = fakeInput();
    const ui = new Ui({ stream, input, color: false, interactive: true });
    const store = fakeStore();

    const run = authLoginCommand({ ui, store, verify: accepts, readBack: () => port(none) });
    await answer(input, ["example.atlassian.net", BASE_URL, EMAIL, SECRET]);

    // One mistyped URL used to cost the whole login.
    expect(await run).toBe(0);
    expect(store.held?.baseUrl).toBe(BASE_URL);
  });

  it("re-asks an empty email before it ever asks for a token", async () => {
    const stream = captureStream();
    const input = fakeInput();
    const ui = new Ui({ stream, input, color: false, interactive: true });
    const store = fakeStore();

    const run = authLoginCommand({ ui, store, verify: accepts, readBack: () => port(none) });
    await answer(input, [BASE_URL, "", EMAIL, SECRET]);

    expect(await run).toBe(0);
    expect(store.held?.email).toBe(EMAIL);
    // The token line was consumed by the token prompt, not eaten by the email
    // step - which is the whole point of validating email where it is asked.
    expect(store.held?.apiToken).toBe(SECRET);
    expect(stream.text()).toMatch(/email is required/);
  });

  it("gives up on an empty email without asking for a token", async () => {
    const stream = captureStream();
    const input = fakeInput();
    const ui = new Ui({ stream, input, color: false, interactive: true });
    const store = fakeStore();

    const run = authLoginCommand({ ui, store, verify: accepts, readBack: () => port(none) });
    await answer(input, [BASE_URL, "", "", ""]);

    expect(await run).toBe(1);
    expect(store.writes).toBe(0);
    // Asking for a secret only to reject the line before it is the behaviour
    // this replaces.
    expect(stream.text()).not.toContain("Atlassian API token");
  });

  it("warns when an exported variable shadows part of what was stored", async () => {
    const stream = captureStream();
    const input = fakeInput();
    const ui = new Ui({ stream, input, color: false, interactive: true });

    // One stale `export` is enough: the chain merges per field, so the origin
    // splits and the stored value is only partly what JAM will actually use.
    const run = authLoginCommand({
      ui,
      store: fakeStore(),
      verify: accepts,
      readBack: () => port({ baseUrl: BASE_URL, email: EMAIL, hasToken: true, source: "mixed" }),
    });
    await answer(input, [BASE_URL, EMAIL, SECRET]);

    expect(await run).toBe(0);
    expect(stream.text()).toMatch(/override part of the stored credentials/);
    expect(stream.text()).toMatch(/Effective source: mixed/);
  });

  it("warns when exported variables shadow the stored credentials entirely", async () => {
    const stream = captureStream();
    const input = fakeInput();
    const ui = new Ui({ stream, input, color: false, interactive: true });

    const run = authLoginCommand({
      ui,
      store: fakeStore(),
      verify: accepts,
      readBack: () => port({ baseUrl: BASE_URL, email: EMAIL, hasToken: true, source: "process" }),
    });
    await answer(input, [BASE_URL, EMAIL, SECRET]);

    expect(await run).toBe(0);
    expect(stream.text()).toMatch(/override the stored credentials/);
    expect(stream.text()).toMatch(/Effective source: process/);
  });

  it("stays quiet when nothing shadows the stored credentials", async () => {
    const stream = captureStream();
    const input = fakeInput();
    const ui = new Ui({ stream, input, color: false, interactive: true });

    const run = authLoginCommand({
      ui,
      store: fakeStore(),
      verify: accepts,
      readBack: () => port(storedOnly),
    });
    await answer(input, [BASE_URL, EMAIL, SECRET]);

    expect(await run).toBe(0);
    expect(stream.text()).not.toMatch(/override/);
  });

  it("never echoes the token, whatever the outcome", async () => {
    const stream = captureStream();
    const input = fakeInput();
    const ui = new Ui({ stream, input, color: false, interactive: true });

    const run = authLoginCommand({
      ui,
      store: fakeStore(),
      verify: rejects,
      readBack: () => port(none),
    });
    await answer(input, [BASE_URL, EMAIL, SECRET]);
    await run;

    expect(stream.text()).not.toContain(SECRET);
  });
});

describe("jam auth logout", () => {
  it("removes what was stored and says JAM is no longer authenticated", () => {
    const stream = captureStream();
    const ui = new Ui({ stream, input: fakeInput(), color: false, interactive: true });
    const store = fakeStore({ baseUrl: BASE_URL, email: EMAIL, apiToken: SECRET });

    const code = authLogoutCommand({ ui, store, readBack: () => port(none) });

    expect(code).toBe(0);
    expect(store.held).toBeUndefined();
    expect(stream.text()).toMatch(/no longer authenticated/);
  });

  it("says so when the environment still authenticates JAM", () => {
    const stream = captureStream();
    const ui = new Ui({ stream, input: fakeInput(), color: false, interactive: true });
    const store = fakeStore({ baseUrl: BASE_URL, email: EMAIL, apiToken: SECRET });

    // Removing the stored copy is not the same as logging out, and a silent
    // success here would read as "logged out but still logged in".
    const code = authLogoutCommand({
      ui,
      store,
      readBack: () => port({ baseUrl: BASE_URL, email: EMAIL, hasToken: true, source: "process" }),
    });

    expect(code).toBe(0);
    expect(stream.text()).toMatch(/still resolve/);
    expect(stream.text()).toMatch(/Effective source: process/);
  });

  it("reports a partial leftover as partial", () => {
    const stream = captureStream();
    const ui = new Ui({ stream, input: fakeInput(), color: false, interactive: true });

    const code = authLogoutCommand({
      ui,
      store: fakeStore(),
      readBack: () => port({ baseUrl: BASE_URL, hasToken: false, source: "process" }),
    });

    expect(code).toBe(0);
    expect(stream.text()).toMatch(/Part of a Jira credential still resolves/);
  });
});

describe("toJiraOrigin", () => {
  const cases: [string, string | undefined][] = [
    ["https://example.atlassian.net", "https://example.atlassian.net"],
    ["https://example.atlassian.net/", "https://example.atlassian.net"],
    ["  https://example.atlassian.net///  ", "https://example.atlassian.net"],
    [
      "https://example.atlassian.net/jira/software/c/projects/EXAMPLE/summary",
      "https://example.atlassian.net",
    ],
    ["https://example.atlassian.net/browse/EXAMPLE-234?foo=1#x", "https://example.atlassian.net"],
    ["http://localhost:8080/jira/x", "http://localhost:8080"],
    ["example.atlassian.net", undefined],
    ["", undefined],
    ["file:///etc/passwd", undefined],
    ["javascript:alert(1)", undefined],
  ];

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${String(expected)}`, () => {
      expect(toJiraOrigin(input)).toBe(expected);
    });
  }
});
