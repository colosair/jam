import { spawn, type SpawnOptions } from "node:child_process";
import { LauncherError } from "./errors.js";
import { portableBootstrapCommand } from "./release.js";
import type { ResolvedRuntime } from "./runtime-resolver.js";

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ReturnType<typeof spawn>;

export type DispatchOptions = {
  cwd?: string;
  spawnFn?: SpawnFn;
};

/** Signals forwarded to the child so an editor closing JAM shuts the server down too. */
const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Run the resolved runtime with the caller's arguments.
 *
 * `stdio: "inherit"` is the important part: stdout belongs to the MCP protocol
 * and is handed to the child untouched. The launcher never writes to it - all
 * launcher diagnostics go to stderr.
 *
 * Resolves with the child's exit code. A child killed by a signal is reported
 * as 128 + signal number, matching shell convention, so a supervisor sees the
 * death rather than a false success.
 */
export function dispatch(
  runtime: ResolvedRuntime,
  argv: string[],
  options: DispatchOptions = {},
): Promise<number> {
  const spawnFn = options.spawnFn ?? spawn;
  const command = runtime.executable.command;
  const args = [...runtime.executable.args, ...argv];

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnFn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      stdio: "inherit",
      // npx on Windows is a shell script, not an executable.
      shell: process.platform === "win32" && command === "npx",
    });

    const forward = (signal: NodeJS.Signals) => () => {
      if (!child.killed) child.kill(signal);
    };
    const handlers = FORWARDED_SIGNALS.map((signal) => {
      const handler = forward(signal);
      process.on(signal, handler);
      return [signal, handler] as const;
    });
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      rejectPromise(
        new LauncherError(
          runtime.mode === "package" ? "JAM_PACKAGE_RUNTIME_FAILED" : "JAM_DEVELOPMENT_SOURCE_INVALID",
          `Could not start the JAM ${runtime.mode} runtime (${command}): ${err.message}`,
          runtime.mode === "package"
            ? undefined
            : portableBootstrapCommand("runtime use development <path>"),
        ),
      );
    });

    child.on("exit", (code, signal) => {
      cleanup();
      if (signal) {
        const number = SIGNAL_NUMBERS[signal] ?? 15;
        resolvePromise(128 + number);
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}

const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
};
