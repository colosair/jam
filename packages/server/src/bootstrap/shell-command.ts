import { delimiter } from "node:path";

/**
 * How to hand an npm-shim CLI to spawnSync without tripping DEP0190.
 *
 * npm-installed CLIs (`claude`, `codex`, `npm`, `npx`, `jam`) are `.cmd`
 * shims on Windows, and Node only runs those through a shell. But passing an
 * args ARRAY together with `shell: true` is deprecated (DEP0190): Node
 * concatenates the arguments without escaping, so the array form is an
 * illusion of safety. On Windows the argv is therefore joined into a single
 * command line HERE, deliberately - and every token is validated bare first,
 * so the join cannot become a quoting hazard. A token that would need cmd.exe
 * quoting is refused outright rather than escaped: nothing JAM runs ever
 * carries one, so meeting one means the input is not ours to guess about.
 *
 * On every other platform the array form without a shell is correct and
 * unchanged.
 */
export type ShellInvocation = {
  command: string;
  args: string[];
  shell: boolean;
};

/** Anything cmd.exe would re-interpret, plus whitespace and quotes. */
const CMD_UNSAFE = /[\s&|<>^"'`;()]/;

export function shellInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ShellInvocation {
  if (platform !== "win32") return { command, args: [...args], shell: false };
  const unsafe = [command, ...args].find((token) => token === "" || CMD_UNSAFE.test(token));
  if (unsafe !== undefined) {
    throw new Error(`refusing to pass a token through cmd.exe unquoted: ${JSON.stringify(unsafe)}`);
  }
  return { command: [command, ...args].join(" "), args: [], shell: true };
}

/**
 * PATH with package-runner injections removed.
 *
 * `npx --yes @jam-mcp/bootstrap@X` prepends its cache's `node_modules/.bin`
 * to PATH, and that directory contains a `jam` shim - so inside a bootstrap
 * run, `jam` resolves even on a machine where nothing is installed. Measuring
 * "does this machine have a persistent jam" through that PATH answered yes on
 * every fresh machine, and setup then registered a bare `jam serve` that died
 * the moment npx's directory evaporated (the v1.4.2 fresh-install field
 * failure). A persistent install lives in npm's global bin, never under a
 * `node_modules` or `_npx` directory, so those entries are dropped before the
 * measurement.
 */
export function stripPackageRunnerPath(pathValue: string, separator: string = delimiter): string {
  return pathValue
    .split(separator)
    .filter((entry) => !/[\\/]node_modules[\\/]|[\\/]_npx[\\/]/.test(`${entry}/`.replace(/[\\/]+$/, "/")))
    .join(separator);
}
