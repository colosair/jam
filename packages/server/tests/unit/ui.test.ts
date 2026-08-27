import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  NonInteractiveError,
  reportPromptError,
  Ui,
  colorEnabled,
  interactiveEnabled,
  SYMBOLS,
} from "../../src/cli/ui.js";

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

describe("reportPromptError", () => {
  it("prints the hint as given, without dressing it up as a command", () => {
    const stream = captureStream(false);
    const ui = new Ui({ stream, input: fakeInput(false), color: false, interactive: false });

    const code = reportPromptError(
      new NonInteractiveError(
        "Atlassian API token",
        "Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN instead.",
      ),
      ui,
    );

    expect(code).toBe(1);
    expect(stream.text()).toContain("Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN instead.");
    // "Run:" in front of a sentence promises something pasteable, and JAM does
    // not know this shell. Command-shaped hints carry their own prefix.
    expect(stream.text()).not.toContain("Run:");
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

  it("leaves nothing behind after an answer either", async () => {
    const input = fakeInput(true);
    const ui = new Ui({ stream: captureStream(true), input, color: false, interactive: true });

    const answer = ui.secret("Jira API token", "hint");
    await type(input, "tok\r");

    expect(await answer).toBe("tok");
    // Teardown is in finally, so the success path clears up exactly as the
    // cancel path does.
    expect(input.listenerCount("keypress")).toBe(0);
    expect(input.isPaused()).toBe(true);
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

  it("lets readline own the line editor, so escape sequences never become text", async () => {
    const input = fakeInput(true);
    const ui = new Ui({ stream: captureStream(true), input, color: false, interactive: true });

    const answer = ui.prompt("Paste your Jira URL", "hint");
    // Arrow-up used to land in the buffer as the literal text "[A".
    await type(input, "ab\u001b[Ac\r");

    expect(await answer).toBe("abc");
  });

  it("runs a real line editor, not a raw read", async () => {
    const input = fakeInput(true);
    const ui = new Ui({ stream: captureStream(true), input, color: false, interactive: true });

    const answer = ui.prompt("Paste your Jira URL", "hint");
    // Ctrl-A to the start, forward-delete the "a", type "Z" in its place.
    await type(input, "abc\u0001\u001b[3~Z\r");

    // What JAM owns: the interface is wired to a TTY-mode readline, so the
    // control sequences reach the line editor instead of landing in the
    // answer. A raw read would hand back the escape bytes verbatim.
    const edited = await answer;
    expect(edited).not.toContain("\u001b");
    expect(edited).not.toContain("\u0001");
    expect(edited).toContain("Z");
    // The forward-delete removed a character: three in, three out, one of
    // them replaced rather than appended to.
    expect(edited).toHaveLength(3);
  });

  // Where the "Z" lands is readline's business, and Node changed it: Node 20
  // answers "bcZ" where Node 22 answers "Zbc" for the same key sequence. JAM
  // delegates line editing to readline on purpose rather than reimplementing
  // it, so the exact cursor semantics are pinned only where they are stable.
  // The engines range stays >=20; what narrowed is which host behaviour this
  // suite claims to guarantee.
  it.skipIf(Number(process.versions.node.split(".")[0]) < 22)(
    "puts the typed character where the cursor is (Node 22+)",
    async () => {
      const input = fakeInput(true);
      const ui = new Ui({ stream: captureStream(true), input, color: false, interactive: true });

      const answer = ui.prompt("Paste your Jira URL", "hint");
      await type(input, "abc\u0001\u001b[3~Z\r");

      expect(await answer).toBe("Zbc");
    },
  );

  it("cancels on Ctrl-C", async () => {
    const input = fakeInput(true);
    const ui = new Ui({ stream: captureStream(true), input, color: false, interactive: true });

    // Escape belongs to the line editor now; Ctrl-C is the cancel key here.
    const rejection = expect(ui.prompt("Paste your Jira URL", "hint")).rejects.toMatchObject({
      name: "CancelledError",
    });
    await type(input, "\u0003");

    await rejection;
  });

  it("cancels rather than hanging when stdin ends mid-question", async () => {
    const input = fakeInput(true);
    const ui = new Ui({ stream: captureStream(true), input, color: false, interactive: true });

    // A finite stdin that stops answering must fail the run, not wedge it -
    // this is what keeps a bounded retry loop bounded.
    const rejection = expect(ui.prompt("Paste your Jira URL", "hint")).rejects.toMatchObject({
      name: "CancelledError",
    });
    await new Promise((r) => setImmediate(r));
    (input as unknown as { end: () => void }).end();

    await rejection;
  });

  it("leaves no keypress listener behind", async () => {
    const input = fakeInput(true);
    const ui = new Ui({ stream: captureStream(true), input, color: false, interactive: true });

    const answer = ui.prompt("Jira email", "hint");
    await type(input, "user@example.com\r");

    expect(await answer).toBe("user@example.com");
    expect(input.listenerCount("keypress")).toBe(0);
  });
});

describe("Ui.select", () => {
  it("returns the highlighted choice and leaves nothing behind", async () => {
    const input = fakeInput(true);
    const ui = new Ui({ stream: captureStream(true), input, color: false, interactive: true });

    const chosen = ui.select(
      "How will you use JAM?",
      [
        { value: "package", label: "Use JAM" },
        { value: "development", label: "Develop JAM" },
      ],
      "jam runtime use package",
    );
    await type(input, "\u001b[B\r");

    expect(await chosen).toBe("development");
    expect(input.listenerCount("keypress")).toBe(0);
    expect(input.isPaused()).toBe(true);
  });
});

describe("Ui.secret delete keys", () => {
  // Terminals disagree on what Backspace sends, and a Delete key arrives as a
  // named escape sequence. Every one of these has to erase a character, or the
  // token prompt looks broken while the buffer quietly keeps the text. Only
  // `secret` still owns these: `prompt` hands them to readline.
  const deleteKeys: [string, string][] = [
    ["DEL (0x7f)", "\u007f"],
    ["BS (0x08)", "\b"],
    ["Delete escape sequence", "\u001b[3~"],
  ];

  for (const [label, key] of deleteKeys) {
    it(`erases on ${label}`, async () => {
      const input = fakeInput(true);
      const ui = new Ui({ stream: captureStream(true), input, color: false, interactive: true });

      const answer = ui.secret("Token", "hint");
      await type(input, `abc${key}${key}x\r`);

      expect(await answer).toBe("ax");
    });
  }

  it("ignores a delete on an empty buffer", async () => {
    const input = fakeInput(true);
    const ui = new Ui({ stream: captureStream(true), input, color: false, interactive: true });

    const answer = ui.secret("Token", "hint");
    await type(input, "\u007f\u007f\bok\r");

    expect(await answer).toBe("ok");
  });

  it("erases in a masked prompt without putting anything on screen", async () => {
    const stream = captureStream(true);
    const input = fakeInput(true);
    const ui = new Ui({ stream, input, color: false, interactive: true });

    const answer = ui.secret("Token", "hint");
    await type(input, "secr3t\u007f\u007fet\r");

    expect(await answer).toBe("secret");
    expect(stream.text()).not.toContain("secr");
    expect(stream.text()).not.toContain("et");
  });
});
