import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import {
  CREDENTIAL_ENV_KEYS,
  type CredentialValueSource,
  type RawCredentialValues,
} from "./process-env.js";

/**
 * Credentials held by the operating system for this user, rather than by a
 * shell profile.
 *
 * This is what makes JAM work in an editor launched from a Dock or Start menu.
 * Such an editor never sourced a shell profile, so the MCP child it spawns
 * inherits no `JIRA_*` at all - but it does run as the user, so it can read
 * what the OS is holding for that user.
 *
 * The stored value never appears in a log, an error, or a tool result. It is
 * read into memory, handed to the credential chain, and nothing else.
 */
export type StoredCredentials = {
  baseUrl: string;
  email: string;
  apiToken: string;
};

export type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
};

/**
 * Injected by tests so the suite never touches a real keychain.
 *
 * `env` is merged over the inherited environment, and carries only values that
 * are not secret - a file path, say. Secrets travel on stdin.
 */
export type RunFn = (
  command: string,
  args: string[],
  input?: string,
  env?: Record<string, string>,
) => RunResult;

export interface SecretStore {
  /** Shown by `jam auth login`. Names the mechanism, never a value. */
  readonly label: string;
  /** Missing or unreadable resolves to undefined - reading never throws. */
  read(): StoredCredentials | undefined;
  /** Throws on failure: the user just asked for this and must not be told it worked. */
  write(values: StoredCredentials): void;
  /** Succeeds when there was nothing to remove. */
  clear(): void;
}

/** Raised when the platform's backend is absent, as opposed to empty. */
export class SecretStoreUnavailableError extends Error {
  readonly remedy: string;

  constructor(message: string, remedy: string) {
    super(message);
    this.name = "SecretStoreUnavailableError";
    this.remedy = remedy;
  }
}

/** Derived from constants, never from user input, except the account name. */
const SERVICE = "jam-mcp";

/**
 * Escape hatch for isolated test sandboxes.
 *
 * An OS secret store is per-user, not per-HOME, so a sandbox that repoints HOME
 * still reads the developer's real keychain - the same hole the Windows
 * registry source has always had. This is not a user-facing feature: it exists
 * so `npm run smoke` can be offline and deterministic, and `jam auth login`
 * reports it distinctly rather than claiming no store exists.
 */
const DISABLE_ENV = "JAM_DISABLE_SECRET_STORE";

export function secretStoreDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[DISABLE_ENV]);
}

function account(): string {
  return userInfo().username;
}

function defaultRun(
  command: string,
  args: string[],
  input?: string,
  env?: Record<string, string>,
): RunResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    // No shell: arguments are passed as an array, so nothing is re-parsed.
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

/** Whether a command exists and runs at all. ENOENT is the signal we want. */
function canRun(run: RunFn, command: string, args: string[]): boolean {
  return run(command, args).error?.code !== "ENOENT";
}

function parse(raw: string): StoredCredentials | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
    if (!parsed?.baseUrl || !parsed.email || !parsed.apiToken) return undefined;
    return { baseUrl: parsed.baseUrl, email: parsed.email, apiToken: parsed.apiToken };
  } catch {
    // A corrupt entry is treated as absent. Reading is one step of credential
    // resolution and must not turn into a crash on an unrelated command.
    return undefined;
  }
}

/**
 * macOS login Keychain.
 *
 * The item is created and read by the same binary (`/usr/bin/security`), which
 * is what keeps the OS from prompting for approval on every read.
 */
function macosStore(run: RunFn): SecretStore {
  const base = ["-s", SERVICE, "-a", account()];
  return {
    label: "macOS Keychain",
    read() {
      const res = run("security", ["find-generic-password", ...base, "-w"]);
      if (res.error || res.status !== 0) return undefined;
      return parse(res.stdout.trim());
    },
    write(values) {
      // `-U` updates in place rather than failing on an existing item.
      // The secret rides in argv here because `security` reads its -w prompt
      // from the controlling terminal, not stdin, and we already collected the
      // token through our own masked prompt - prompting again would be worse.
      // Visible only to this user, for the lifetime of one short-lived child.
      const res = run("security", [
        "add-generic-password",
        ...base,
        "-U",
        "-w",
        JSON.stringify(values),
      ]);
      if (res.error?.code === "ENOENT") throw unavailable("security");
      if (res.status !== 0) throw new Error(`Keychain write failed: ${res.stderr.trim()}`);
    },
    clear() {
      run("security", ["delete-generic-password", ...base]);
    },
  };
}

/** Linux libsecret, via the `secret-tool` CLI. */
function linuxStore(run: RunFn): SecretStore {
  const attrs = ["service", SERVICE, "account", account()];
  return {
    label: "libsecret (secret-tool)",
    read() {
      const res = run("secret-tool", ["lookup", ...attrs]);
      if (res.error || res.status !== 0) return undefined;
      return parse(res.stdout.trim());
    },
    write(values) {
      // secret-tool reads the secret from stdin, so it never reaches argv.
      const res = run(
        "secret-tool",
        ["store", "--label", "JAM (Jira Agent MCP)", ...attrs],
        JSON.stringify(values),
      );
      if (res.error?.code === "ENOENT") throw unavailable("secret-tool");
      if (res.status !== 0) throw new Error(`secret-tool store failed: ${res.stderr.trim()}`);
    },
    clear() {
      run("secret-tool", ["clear", ...attrs]);
    },
  };
}

/**
 * Windows: a file encrypted to the current user account with DPAPI.
 *
 * Credential Manager is not usable here - `cmdkey` can store a credential but
 * cannot read one back, and reading it needs either a P/Invoke or a PowerShell
 * module that is not installed by default.
 *
 * The confidentiality boundary is DPAPI's current-user binding. The 0o600 mode
 * on the file is best-effort hardening on top, not the thing protecting it -
 * Node's mode argument does not carry POSIX semantics on Windows.
 *
 * Kept separate from ~/.jam/config.yaml, which declares itself hand-editable
 * and free of credentials.
 */
/**
 * Both scripts need DPAPI, and both must survive a host that rewrote where
 * PowerShell looks for modules.
 *
 * A CI runner does exactly that - it prepends its own paths, including ones
 * belonging to a different PowerShell edition, and then Windows PowerShell 5.1
 * either cannot resolve `ConvertTo-SecureString` at all or trips over type data
 * from a module that was never meant for it. Neither failure says anything
 * about credentials, so both look like a JAM bug to whoever reads them.
 *
 * So the child starts from the machine's own module path and asks for the
 * module by name. This changes nothing outside that one short-lived process.
 */
const IMPORT_SECURITY =
  "$env:PSModulePath=[Environment]::GetEnvironmentVariable('PSModulePath','Machine');" +
  "Import-Module Microsoft.PowerShell.Security -ErrorAction Stop;";

/**
 * What the child writes, we read as UTF-8 - so say so before it writes anything.
 *
 * `spawnSync` is told `encoding: "utf8"`, but powershell.exe writes through the
 * console code page, which on a Korean install is 949. The bytes and the decoder
 * then disagree and an error message arrives as mojibake: the user is handed a
 * failure they cannot even read. Setting the output encoding inside the child
 * changes nothing outside it.
 */
const UTF8_OUTPUT =
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
  "$OutputEncoding=[Text.Encoding]::UTF8;";

/**
 * Read stdin as UTF-8, by saying so on the stream rather than on the console.
 *
 * `[Console]::In` on Windows PowerShell 5.1 is already bound to the console
 * input code page by the time a `-Command` script could change it, so a value
 * with non-ASCII in it - a Jira account under a Korean name, say - arrived
 * mangled and was then encrypted mangled. Opening the standard input stream
 * with an explicit encoding sidesteps that entirely.
 */
const READ_STDIN_UTF8 =
  "$in=(New-Object IO.StreamReader(" +
  "[Console]::OpenStandardInput(),[Text.Encoding]::UTF8)).ReadToEnd();";

function windowsStore(run: RunFn): SecretStore {
  const dir = join(homedir(), ".jam");
  const path = join(dir, "credentials.dpapi");

  /**
   * The path reaches PowerShell in an environment variable, never in argv and
   * never interpolated into the script text.
   *
   * It used to ride as a trailing argument with `-args`, which does not work:
   * `powershell.exe -Command` appends what follows to the command text rather
   * than filling `$args` - that is `-File` semantics - so the script read
   * `$args[0]` as `$null` and `Set-Content` refused the null path. Reading was
   * broken the same way and failed quietly, since `Test-Path $null` is false.
   *
   * The variable holds a path, not a secret. The secret still reaches the
   * process on stdin and appears nowhere else.
   */
  const PATH_VAR = "JAM_SECRET_FILE";
  const decrypt = [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    UTF8_OUTPUT +
      IMPORT_SECURITY +
      `$p=$env:${PATH_VAR}; if(!(Test-Path $p)){exit 1};` +
      "$s=Get-Content $p -Raw | ConvertTo-SecureString;" +
      "[Runtime.InteropServices.Marshal]::PtrToStringAuto(" +
      "[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))",
  ];
  const encrypt = [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    UTF8_OUTPUT +
      IMPORT_SECURITY +
      READ_STDIN_UTF8 +
      "$in | ConvertTo-SecureString -AsPlainText -Force |" +
      ` ConvertFrom-SecureString | Set-Content $env:${PATH_VAR} -NoNewline`,
  ];

  return {
    label: "Windows DPAPI (user-encrypted file)",
    read() {
      if (!existsSync(path)) return undefined;
      const res = run("powershell", decrypt, undefined, { [PATH_VAR]: path });
      if (res.error || res.status !== 0) return undefined;
      return parse(res.stdout.trim());
    },
    write(values) {
      mkdirSync(dir, { recursive: true });
      const res = run("powershell", encrypt, JSON.stringify(values), { [PATH_VAR]: path });
      if (res.error?.code === "ENOENT") throw unavailable("powershell");
      if (res.status !== 0) throw new Error(`DPAPI write failed: ${res.stderr.trim()}`);
      try {
        // Best-effort only; DPAPI is what actually protects the contents.
        writeFileSync(path, "", { flag: "r+", mode: 0o600 });
      } catch {
        /* ignore - the encryption, not the mode, is the boundary */
      }
    },
    clear() {
      rmSync(path, { force: true });
    },
  };
}

function unavailable(command: string): SecretStoreUnavailableError {
  return new SecretStoreUnavailableError(
    `No usable secret store was found on this system (${command} is not available).`,
    command === "secret-tool"
      ? "Install secret-tool (libsecret), or set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN instead."
      : "Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN instead.",
  );
}

/**
 * The store for this system, or undefined when there is none that works.
 *
 * Being on Linux is not the same as having a secret store: a headless server or
 * a container routinely has no libsecret and no session keyring. So the backend
 * is probed, not assumed from `process.platform`.
 */
export function resolveSecretStore(
  run: RunFn = defaultRun,
  env: NodeJS.ProcessEnv = process.env,
): SecretStore | undefined {
  if (secretStoreDisabled(env)) return undefined;
  if (process.platform === "darwin") {
    return canRun(run, "security", ["help"]) ? macosStore(run) : undefined;
  }
  if (process.platform === "win32") {
    return canRun(run, "powershell", ["-NoProfile", "-Command", "$null"])
      ? windowsStore(run)
      : undefined;
  }
  if (process.platform === "linux") {
    return canRun(run, "secret-tool", ["--version"]) ? linuxStore(run) : undefined;
  }
  return undefined;
}

/**
 * The credential chain's view of the store.
 *
 * Fail-soft by design, like the Windows registry source: a machine with no
 * store, or an empty one, is a normal state that must not turn every command
 * into an error. `jam auth login` is where a failure gets reported, because
 * there the user asked for something specific.
 */
export class SecretStoreCredentialSource implements CredentialValueSource {
  /**
   * The store is required, with no default that would resolve a real one.
   * A parameter default cannot tell `undefined` meaning "this system has no
   * store" from `undefined` meaning "not supplied" - and getting that wrong
   * silently reaches the user's real keychain, including from a test.
   */
  constructor(private readonly store: SecretStore | undefined) {}

  read(): RawCredentialValues {
    const stored = this.store?.read();
    if (!stored) return {};

    const values: RawCredentialValues = {};
    const byKey = {
      JIRA_BASE_URL: stored.baseUrl,
      JIRA_EMAIL: stored.email,
      JIRA_API_TOKEN: stored.apiToken,
    };
    for (const key of CREDENTIAL_ENV_KEYS) {
      const value = byKey[key]?.trim();
      if (value) values[key] = value;
    }
    return values;
  }
}
