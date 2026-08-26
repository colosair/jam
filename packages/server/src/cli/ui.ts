import { createInterface, emitKeypressEvents } from "node:readline";

/**
 * The whole of JAM's terminal presentation.
 *
 * Deliberately hand-rolled rather than pulled from a TUI library: JAM needs a
 * status line, a section heading and a single-choice list, and a dependency
 * that renders full-screen frames would be a lot of surface for that. It also
 * keeps the non-TTY path honest - everything here degrades to plain lines.
 */

export type UiOptions = {
  stream?: NodeJS.WriteStream;
  input?: NodeJS.ReadStream;
  /** Force interactivity on or off; defaults to detection. */
  interactive?: boolean;
  color?: boolean;
};

export const SYMBOLS = {
  section: "◆",
  success: "✓",
  warning: "!",
  failure: "×",
  selected: "❯",
  pending: "○",
  next: "›",
} as const;

// Escape sequences are spelled out rather than typed literally: a raw 0x1b in
// source is invisible in most editors and does not survive careless tooling.
const CSI = "[";

const ANSI = {
  reset: `${CSI}0m`,
  dim: `${CSI}2m`,
  cyan: `${CSI}36m`,
  green: `${CSI}32m`,
  yellow: `${CSI}33m`,
  red: `${CSI}31m`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
} as const;

const cursorUp = (rows: number) => `${CSI}${rows}A`;

/**
 * Colour is suppressed for NO_COLOR, for CI, and for anything that is not a
 * TTY - a log file full of escape codes helps nobody. Meaning is never carried
 * by colour alone; every state also has a distinct symbol.
 */
export function colorEnabled(
  stream: NodeJS.WriteStream,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env["NO_COLOR"] !== undefined) return false;
  if (env["CI"]) return false;
  return Boolean(stream.isTTY);
}

export function interactiveEnabled(
  stream: NodeJS.WriteStream,
  input: NodeJS.ReadStream,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env["CI"]) return false;
  return Boolean(stream.isTTY && input.isTTY);
}

export class CancelledError extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "CancelledError";
  }
}

/**
 * Raised when a question is unavoidable but there is no terminal to ask it in.
 * Distinct from any JAM/Jira error: nothing is wrong with the setup, there is
 * just no one to answer, and the fix is a flag rather than a diagnosis.
 */
export class NonInteractiveError extends Error {
  /** A whole instruction, printed as given - not a bare flag or command. */
  readonly flagHint: string;

  constructor(question: string, flagHint: string) {
    super(`${question} cannot be asked without a terminal.`);
    this.name = "NonInteractiveError";
    this.flagHint = flagHint;
  }
}

/**
 * The one mapping of a prompt that could not run to an exit code.
 *
 * Returns undefined for anything else, which the caller must rethrow: a
 * cancelled prompt is not a failure, and a missing terminal is guidance rather
 * than a diagnosis, but a real fault must still surface as one.
 */
export function reportPromptError(err: unknown, ui: Ui): number | undefined {
  if (err instanceof CancelledError) {
    ui.line();
    ui.warn("Cancelled. Nothing was changed.");
    return 130;
  }
  if (err instanceof NonInteractiveError) {
    ui.line();
    ui.failure(err.message);
    // Printed verbatim. A hint that is a sentence must not be dressed up as a
    // command the user could paste, and JAM cannot know their shell anyway.
    ui.next(err.flagHint);
    return 1;
  }
  return undefined;
}

export type Choice<T> = {
  value: T;
  label: string;
  /** Shown dimmed under the label. */
  hint?: string;
};

export class Ui {
  readonly interactive: boolean;
  private readonly stream: NodeJS.WriteStream;
  private readonly input: NodeJS.ReadStream;
  private readonly useColor: boolean;

  constructor(options: UiOptions = {}) {
    this.stream = options.stream ?? process.stdout;
    this.input = options.input ?? process.stdin;
    this.useColor = options.color ?? colorEnabled(this.stream);
    this.interactive = options.interactive ?? interactiveEnabled(this.stream, this.input);
  }

  private paint(text: string, code: keyof typeof ANSI): string {
    return this.useColor ? `${ANSI[code]}${text}${ANSI.reset}` : text;
  }

  write(text: string): void {
    this.stream.write(text);
  }

  line(text = ""): void {
    this.write(`${text}\n`);
  }

  /**
   * A stage heading. Sections replace a rigid "[2/5]" counter, which lies
   * whenever a step turns out to be already done and gets skipped.
   */
  section(title: string, subtitle?: string): void {
    this.line();
    this.line(`${this.paint(SYMBOLS.section, "cyan")} ${title}`);
    if (subtitle) this.line(`  ${this.paint(subtitle, "dim")}`);
  }

  success(text: string, detail?: string): void {
    this.status(this.paint(SYMBOLS.success, "green"), text, detail);
  }

  warn(text: string, detail?: string): void {
    this.status(this.paint(SYMBOLS.warning, "yellow"), text, detail);
  }

  failure(text: string, detail?: string): void {
    this.status(this.paint(SYMBOLS.failure, "red"), text, detail);
  }

  pending(text: string, detail?: string): void {
    this.status(this.paint(SYMBOLS.pending, "dim"), text, detail);
  }

  next(text: string): void {
    this.line();
    this.line(`${this.paint(SYMBOLS.next, "cyan")} ${text}`);
  }

  private status(symbol: string, text: string, detail?: string): void {
    const padded = detail ? text.padEnd(22) : text;
    this.line(`${symbol} ${padded}${detail ? ` ${this.paint(detail, "dim")}` : ""}`);
  }

  /**
   * Spinner for genuine waiting only - a network round trip, a package
   * download. Spinning while reading a local file is theatre that makes fast
   * operations look slow.
   */
  async spin<T>(label: string, work: () => Promise<T>): Promise<T> {
    if (!this.interactive) {
      this.pending(label);
      return work();
    }

    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    this.write(ANSI.hideCursor);
    const timer = setInterval(() => {
      this.write(`\r${this.paint(frames[i % frames.length]!, "cyan")} ${label}`);
      i++;
    }, 80);

    try {
      return await work();
    } finally {
      clearInterval(timer);
      this.write(`\r${" ".repeat(label.length + 4)}\r`);
      this.write(ANSI.showCursor);
    }
  }

  /**
   * Free-text answer, echoed as it is typed.
   *
   * The line editor is Node's readline, not JAM's: IME composition, CJK width,
   * grapheme deletion, cursor movement and paste are the terminal's job, and a
   * hand-rolled reader gets every one of them wrong. Cancelling is Ctrl-C,
   * Ctrl-D or a closed stdin - readline swallows a lone Escape, so unlike
   * `secret()` and `select()` this prompt cannot be cancelled with it.
   */
  async prompt(question: string, flagHint: string, fallback?: string): Promise<string> {
    if (!this.interactive) throw new NonInteractiveError(question, flagHint);

    const suffix = fallback ? ` ${this.paint(`[${fallback}]`, "dim")}` : "";
    // One interface per question, closed in finally. A long-lived one on
    // process.stdin would swallow the MCP stdio transport in `jam serve`.
    // historySize 0: a Jira URL and an email are the user's, not JAM's to keep.
    const rl = createInterface({
      input: this.input,
      output: this.stream,
      terminal: true,
      historySize: 0,
    });
    try {
      const answer = await new Promise<string>((resolve, reject) => {
        // Ctrl-C, Ctrl-D and a stdin that ends all arrive as `close`. Without
        // this the question would hang on a stream nobody is answering.
        rl.once("close", () => reject(new CancelledError()));
        rl.question(`${question}${suffix} `, resolve);
      });
      return answer || (fallback ?? "");
    } finally {
      rl.close();
    }
  }

  /**
   * Secret answer - nothing typed is ever echoed, to this stream or any other.
   *
   * No dots, no length hint, no redraw: an API token pasted into a terminal
   * should leave no trace on screen for someone glancing over, in a screen
   * share, or in scrollback.
   */
  async secret(question: string, flagHint: string): Promise<string> {
    if (!this.interactive) throw new NonInteractiveError(question, flagHint);
    return this.readSecret(question);
  }

  /**
   * The only place raw mode and a hand-managed buffer still live.
   *
   * A token needs four things - no echo, paste, delete, Enter - and a line
   * editor that echoes nothing is not something readline offers. Everything
   * `prompt` needs and this does not - cursor movement, IME, character width -
   * stays out.
   */
  private async readSecret(question: string): Promise<string> {
    this.write(`${question} `);

    emitKeypressEvents(this.input);
    const wasRaw = this.input.isRaw ?? false;
    this.input.setRawMode?.(true);
    this.input.resume();

    let buffer = "";
    let removeListener = () => {};
    try {
      return await new Promise<string>((resolve, reject) => {
        const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
          if (key.name === "return" || key.name === "enter") {
            this.line();
            resolve(buffer);
            return;
          }
          if (key.name === "escape" || (key.ctrl && key.name === "c")) {
            this.line();
            reject(new CancelledError());
            return;
          }
          // Every shape a delete arrives in. Terminals disagree: Backspace may
          // send DEL (0x7f) or BS (0x08), and a Delete key can arrive as an
          // escape sequence that readline names "delete". Matching only
          // key.name === "backspace" leaves the rest to fall through to the
          // printable branch, where they are stripped to "" and silently do
          // nothing - which reads as "backspace is broken".
          if (
            key.name === "backspace" ||
            key.name === "delete" ||
            str === "\u007f" ||
            str === "\b"
          ) {
            // Drops one UTF-16 unit, not one grapheme. An API token is ASCII,
            // and no Unicode editor is coming here - that is what `prompt` and
            // readline are for.
            if (buffer.length === 0) return;
            buffer = buffer.slice(0, -1);
            return;
          }
          // Ignore control keys; take printable characters, including whole
          // runs of them, which is how a paste arrives.
          if (key.ctrl || str === undefined || str === "") return;
          const printable = str.replace(/[\u0000-\u001f\u007f]/g, "");
          if (!printable) return;
          buffer += printable;
        };
        removeListener = () => this.input.off("keypress", onKey);
        this.input.on("keypress", onKey);
      });
    } finally {
      // Teardown lives here and nowhere else: a listener stranded by a throw
      // would let the next prompt receive the tail of a token. No cursor
      // restore - this never hides it, and a no-op write would only suggest
      // otherwise.
      removeListener();
      this.input.setRawMode?.(wasRaw);
      this.input.pause();
    }
  }

  /**
   * Single-choice list. Throws in non-interactive mode rather than silently
   * picking a default - an unattended run that quietly chose for you is worse
   * than one that tells you which flag to pass.
   */
  async select<T>(question: string, choices: Choice<T>[], flagHint: string): Promise<T> {
    if (choices.length === 0) throw new Error("select() needs at least one choice");
    if (!this.interactive) throw new NonInteractiveError(question, flagHint);

    let index = 0;
    const rows = choices.length * 2 + 1;
    const render = (first: boolean) => {
      if (!first) this.write(cursorUp(rows));
      this.line(question);
      choices.forEach((choice, i) => {
        const active = i === index;
        const marker = active ? this.paint(SYMBOLS.selected, "cyan") : " ";
        const label = active ? this.paint(choice.label, "cyan") : choice.label;
        this.line(`${marker} ${label}`);
        this.line(`  ${this.paint(choice.hint ?? "", "dim")}`);
      });
    };

    render(true);
    this.write(ANSI.hideCursor);
    emitKeypressEvents(this.input);
    const wasRaw = this.input.isRaw ?? false;
    this.input.setRawMode?.(true);
    this.input.resume();

    let removeListener = () => {};
    try {
      return await new Promise<T>((resolve, reject) => {
        const onKey = (_str: string, key: { name?: string; ctrl?: boolean }) => {
          if (key.name === "up") {
            index = (index - 1 + choices.length) % choices.length;
            render(false);
          } else if (key.name === "down") {
            index = (index + 1) % choices.length;
            render(false);
          } else if (key.name === "return") {
            resolve(choices[index]!.value);
          } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
            reject(new CancelledError());
          }
        };
        removeListener = () => this.input.off("keypress", onKey);
        this.input.on("keypress", onKey);
      });
    } finally {
      removeListener();
      this.input.setRawMode?.(wasRaw);
      this.input.pause();
      this.write(ANSI.showCursor);
    }
  }
}
