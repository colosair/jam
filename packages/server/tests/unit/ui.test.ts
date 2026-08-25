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
