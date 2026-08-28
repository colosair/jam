import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveSecretStore,
  type RunFn,
  type RunResult,
  type StoredCredentials,
} from "../../src/adapters/credentials/secret-store.js";

/**
 * The Windows store against a real `powershell.exe`.
 *
 * Every other secret-store test injects a runner, which is what kept a broken
 * contract green: the fake answered `status: 0` to a command that, run for
 * real, could not see its own argument. `-Command` does not populate `$args`
 * from trailing argv - that is `-File` semantics - so `$args[0]` was `$null`
 * and `Set-Content` refused the null path. Only a real process can hold that.
 *
 * HOME/USERPROFILE point at a throwaway directory (tests/setup-env.ts), so
 * this writes a DPAPI blob under a temp home, never the developer's own.
 */

const windows = process.platform === "win32";
const describeWindows = windows ? describe : describe.skip;

const SECRET = "atatt-not-a-real-token-0123456789";
const values = (over: Partial<StoredCredentials> = {}): StoredCredentials => ({
  baseUrl: "https://example.atlassian.net",
  email: "user@example.com",
  apiToken: SECRET,
  ...over,
});

const blob = () => join(homedir(), ".jam", "credentials.dpapi");

/** The real runner, plus a record of what actually reached the process. */
type Call = { command: string; args: string[]; input?: string; env?: Record<string, string> };

function realRun(): { run: RunFn; calls: Call[]; outputs: RunResult[] } {
  const calls: Call[] = [];
  const outputs: RunResult[] = [];
  const run: RunFn = (command, args, input, env) => {
    calls.push({
      command,
      args,
      ...(input === undefined ? {} : { input }),
      ...(env === undefined ? {} : { env }),
    });
    const result = spawnSync(command, args, {
      encoding: "utf8",
      ...(input === undefined ? {} : { input }),
      // The store passes the file path here. Dropping it is how this harness
      // first reported the fixed code as broken.
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
      windowsHide: true,
    });
    const out: RunResult = {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error ? { error: result.error } : {}),
    };
    outputs.push(out);
    return out;
  };
  return { run, calls, outputs };
}

const storeWith = (run: RunFn) => {
  // Empty env on purpose: the suite sets JAM_DISABLE_SECRET_STORE, and this
  // case is about the backend that switch turns off.
  const resolved = resolveSecretStore(run, {});
  if (!resolved) throw new Error("no secret store backend resolved on win32");
  return resolved;
};

describeWindows("Windows DPAPI store, against a real powershell.exe", () => {
  afterEach(() => {
    rmSync(blob(), { force: true });
  });

  it("writes an encrypted file that the same store reads back", () => {
    const { run } = realRun();
    const store = storeWith(run);

    store.write(values());

    expect(existsSync(blob()), "no DPAPI file was written").toBe(true);
    expect(store.read()).toEqual(values());
  });

  it("round-trips values that are not ASCII", () => {
    const { run } = realRun();
    const store = storeWith(run);
    const korean = values({ email: "한글@example.com" });

    store.write(korean);

    expect(store.read()).toEqual(korean);
  });

  it("clear removes the file, and a read after it finds nothing", () => {
    const { run } = realRun();
    const store = storeWith(run);
    store.write(values());

    store.clear();

    expect(existsSync(blob())).toBe(false);
    expect(store.read()).toBeUndefined();
  });

  it("keeps the token out of argv, out of the file, and out of the output", () => {
    const { run, calls, outputs } = realRun();
    const store = storeWith(run);

    store.write(values());
    const read = store.read();

    expect(read?.apiToken).toBe(SECRET);
    // The secret rides on stdin. Nothing else may carry it.
    for (const call of calls) {
      expect(call.args.join(" "), `secret reached argv of ${call.command}`).not.toContain(SECRET);
      expect(JSON.stringify(call.env ?? {})).not.toContain(SECRET);
    }
    // stdout of the read is the decrypted payload by design; stderr never is.
    for (const out of outputs) expect(out.stderr).not.toContain(SECRET);
    expect(readFileSync(blob(), "utf8"), "the stored file holds the token in clear").not.toContain(
      SECRET,
    );
  });
});

/**
 * The encoding half of the same story, kept apart from correctness on purpose.
 *
 * The user's failure arrived as mojibake: powershell.exe writes through the
 * console code page (949 on their machine) while `spawnSync` decodes as UTF-8.
 * That is a separate defect from the null path - it makes a message unreadable
 * rather than making storage fail - so it is proven separately, and by running
 * a real shell rather than by reasoning about code pages.
 */
describeWindows("PowerShell output encoding", () => {
  const marker = "한글 오류 메시지";
  const write = `[Console]::Error.WriteLine('${marker}')`;

  const stderrOf = (script: string): string => {
    const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    });
    return result.stderr ?? "";
  };

  it("declaring UTF-8 in the child makes non-ASCII stderr survive the trip", () => {
    const withDeclaration = stderrOf(
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;${write}`,
    );

    expect(withDeclaration).toContain(marker);
  });

  it("the store's own scripts carry that declaration", () => {
    const { run, calls } = realRun();
    const store = storeWith(run);

    store.write(values());

    const script = calls.at(-1)!.args.join(" ");
    expect(script).toContain("[Console]::OutputEncoding=[Text.Encoding]::UTF8");
  });
});
