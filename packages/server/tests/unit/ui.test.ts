import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Ui, colorEnabled, interactiveEnabled, SYMBOLS } from "../../src/cli/ui.js";

/** A writable that records everything, standing in for stdout. */
function captureStream(isTTY: boolean): NodeJS.WriteStream & { text: () => string } {
  const chunks: string[] = [];
  const stream = new PassThrough() as unknown as NodeJS.WriteStream & { text: () => string };
  (stream as unknown as { isTTY: boolean }).isTTY = isTTY;
  const original = stream.write.bind(stream);
  stream.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return original(chunk);
  }) as typeof stream.write;
  stream.text = () => chunks.join("");
  return stream;
}

function fakeInput(isTTY: boolean): NodeJS.ReadStream {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  (input as unknown as { isTTY: boolean }).isTTY = isTTY;
  return input;
}

const ESC_PATTERN = /\[/;

describe("colorEnabled", () => {
  const tty = captureStream(true);

  it("is on for a plain TTY", () => {
    expect(colorEnabled(tty, {})).toBe(true);
  });

  it("respects NO_COLOR even when empty", () => {
    expect(colorEnabled(tty, { NO_COLOR: "" })).toBe(false);
    expect(colorEnabled(tty, { NO_COLOR: "1" })).toBe(false);
  });

  it("is off in CI and off when not a TTY", () => {
    expect(colorEnabled(tty, { CI: "true" })).toBe(false);
    expect(colorEnabled(captureStream(false), {})).toBe(false);
  });
});

describe("interactiveEnabled", () => {
  it("needs both streams to be a TTY, and not CI", () => {
    expect(interactiveEnabled(captureStream(true), fakeInput(true), {})).toBe(true);
    expect(interactiveEnabled(captureStream(true), fakeInput(false), {})).toBe(false);
    expect(interactiveEnabled(captureStream(false), fakeInput(true), {})).toBe(false);
    expect(interactiveEnabled(captureStream(true), fakeInput(true), { CI: "1" })).toBe(false);
  });
});

describe("Ui rendering", () => {
  it("emits no escape sequences when colour is off", () => {
    const stream = captureStream(false);
    const ui = new Ui({ stream, input: fakeInput(false), color: false, interactive: false });

    ui.section("Runtime", "how JAM runs here");
    ui.success("Runtime configured", "package");
    ui.warn("Credentials missing");
    ui.failure("Jira authentication", "rejected");
    ui.pending("Checking");
    ui.next("Run jam doctor");

    expect(stream.text()).not.toMatch(ESC_PATTERN);
  });

  it("still distinguishes states by symbol, not colour alone", () => {
    const stream = captureStream(false);
    const ui = new Ui({ stream, input: fakeInput(false), color: false, interactive: false });

    ui.success("ok");
    ui.warn("warn");
    ui.failure("bad");
    ui.pending("waiting");

    const text = stream.text();
    expect(text).toContain(SYMBOLS.success);
    expect(text).toContain(SYMBOLS.warning);
    expect(text).toContain(SYMBOLS.failure);
    expect(text).toContain(SYMBOLS.pending);
  });

  it("emits escape sequences when colour is on", () => {
    const stream = captureStream(true);
    const ui = new Ui({ stream, input: fakeInput(true), color: true, interactive: false });
    ui.success("ok");

    expect(stream.text()).toMatch(ESC_PATTERN);
  });

  it("runs work without a spinner when not interactive, and returns its value", async () => {
    const stream = captureStream(false);
    const ui = new Ui({ stream, input: fakeInput(false), color: false, interactive: false });

    const result = await ui.spin("Checking Jira access...", async () => "done");

    expect(result).toBe("done");
    // A plain pending line, not animation frames.
    expect(stream.text()).toContain("Checking Jira access...");
    expect(stream.text()).not.toContain("\r");
  });

  it("refuses to ask a question without a terminal, and names the flag to use", async () => {
    const ui = new Ui({
      stream: captureStream(false),
      input: fakeInput(false),
      color: false,
      interactive: false,
    });

    const rejection = ui.select(
      "How will you use JAM?",
      [{ value: "package", label: "Use JAM" }],
      "jam runtime use package",
    );

    // Its own error type, so callers can tell "nobody to ask" from a real fault
    // and report it as guidance rather than as a Jira diagnosis.
    await expect(rejection).rejects.toMatchObject({
      name: "NonInteractiveError",
      flagHint: "jam runtime use package",
    });
    await expect(rejection).rejects.toThrow(/cannot be asked without a terminal/);
  });
});

/** Feeds keystrokes to a Ui that is already waiting on them. */
async function type(input: NodeJS.ReadStream, keys: string): Promise<void> {
  await new Promise((r) => setImmediate(r));
  (input as unknown as { write: (chunk: string) => void }).write(keys);
  await new Promise((r) => setImmediate(r));
}

describe("Ui.secret", () => {
  it("refuses to ask without a terminal, and names the way out", async () => {
    const ui = new Ui({
      stream: captureStream(false),
      input: fakeInput(false),
      color: false,
      interactive: false,
    });

    await expect(ui.secret("Jira API token", "export JIRA_API_TOKEN")).rejects.toMatchObject({
      name: "NonInteractiveError",
      flagHint: "export JIRA_API_TOKEN",
    });
  });

  it("never echoes what was typed", async () => {
    const stream = captureStream(true);
    const input = fakeInput(true);
    const ui = new Ui({ stream, input, color: false, interactive: true });

    const answer = ui.secret("Jira API token", "hint");
    await type(input, "SUPER_SECRET_TOKEN\r");

    expect(await answer).toBe("SUPER_SECRET_TOKEN");
    // The point of the whole method: nothing on screen, in a screen share, or
    // in scrollback.
    expect(stream.text()).not.toContain("SUPER_SECRET_TOKEN");
    expect(stream.text()).not.toContain("SUPER");
  });

  it("applies backspace without echoing", async () => {
    const stream = captureStream(true);
    const input = fakeInput(true);
    const ui = new Ui({ stream, input, color: false, interactive: true });

    const answer = ui.secret("Jira API token", "hint");
    await type(input, "abcX\u007f\r");

    expect(await answer).toBe("abc");
    expect(stream.text()).not.toContain("abc");
  });

  it("cancels on escape and leaves the terminal as it found it", async () => {
    const input = fakeInput(true);
    const raw: boolean[] = [];
    (input as unknown as { setRawMode: (v: boolean) => void }).setRawMode = (v) => {
      raw.push(v);
    };
    const ui = new Ui({ stream: captureStream(true), input, color: false, interactive: true });

    const answer = ui.secret("Jira API token", "hint");
    await type(input, "\u001b");

    await expect(answer).rejects.toMatchObject({ name: "CancelledError" });
    expect(raw).toEqual([true, false]);
    // A listener left behind would feed the tail of a token to the next prompt.
    expect(input.listenerCount("keypress")).toBe(0);
  });
});

describe("Ui.prompt", () => {
  it("echoes what was typed and returns it", async () => {
    const stream = captureStream(true);
    const input = fakeInput(true);
    const ui = new Ui({ stream, input, color: false, interactive: true });

    const answer = ui.prompt("Jira email", "hint");
    await type(input, "user@example.com\r");

    expect(await answer).toBe("user@example.com");
    expect(stream.text()).toContain("user@example.com");
  });

  it("falls back to the offered value when the answer is empty", async () => {
    const input = fakeInput(true);
    const ui = new Ui({ stream: captureStream(true), input, color: false, interactive: true });

    const answer = ui.prompt("Jira email", "hint", "already@known.com");
    await type(input, "\r");

    expect(await answer).toBe("already@known.com");
  });
});
