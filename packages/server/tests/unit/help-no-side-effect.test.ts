// Asking a command what it does must not be the same as running it.
//
// Measured on a real machine: `jam setup --help` did not print help. It ran the
// setup wizard, re-registered JAM with two hosts, and moved the recorded
// registration from one version to another - while the person was reading what
// they thought was documentation.
//
// The cause was narrow and the blast radius was not: `--help` was recognised
// only as the command itself, so every subcommand carrying it fell straight
// through to its handler. That includes every mutating path in the dispatcher.
//
// This file pins the contract for all of them at once, rather than for the one
// that was reported. A per-command list is a list that will be incomplete the
// first time somebody adds a command.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { runJamCommand, USAGE } from "../../src/cli-entry.js";

/**
 * Every module the dispatcher can reach that changes something: configuration,
 * registration, credentials, or Jira itself. If one of these is called while a
 * help flag is present, the guard has a hole.
 */
vi.mock("../../src/cli/setup.js", () => ({ setup: vi.fn(async () => 0) }));
vi.mock("../../src/cli/setup-wizard.js", () => ({ runSetupWizard: vi.fn(async () => 0) }));
vi.mock("../../src/cli/update.js", () => ({ jamUpdateCommand: vi.fn(async () => 0) }));
vi.mock("../../src/cli/lifecycle.js", () => ({
  jamRefreshCommand: vi.fn(async () => 0),
  jamStatusCommand: vi.fn(async () => 0),
  jamUninstallCommand: vi.fn(async () => 0),
}));
vi.mock("../../src/cli/runtime.js", () => ({
  showRuntime: vi.fn(async () => 0),
  useRuntime: vi.fn(async () => 0),
}));
vi.mock("../../src/cli/auth.js", () => ({
  authLoginCommand: vi.fn(async () => 0),
  authLogoutCommand: vi.fn(async () => 0),
}));
vi.mock("../../src/cli/jira-write.js", () => ({ runJiraWrite: vi.fn(async () => 0) }));
vi.mock("../../src/cli/jira-read.js", () => ({ runJiraRead: vi.fn(async () => 0) }));
vi.mock("../../src/cli/agent-api.js", () => ({
  authStatusCommand: vi.fn(async () => 0),
  doctorJsonCommand: vi.fn(async () => 0),
  setupAgentCommand: vi.fn(async () => 0),
  setupApplyCommand: vi.fn(async () => 0),
  setupPlanCommand: vi.fn(async () => 0),
}));
vi.mock("../../src/cli/serve.js", () => ({ serve: vi.fn(async () => 0) }));
vi.mock("../../src/cli/doctor.js", () => ({ doctor: vi.fn(async () => 0) }));

const { setup } = await import("../../src/cli/setup.js");
const { runSetupWizard } = await import("../../src/cli/setup-wizard.js");
const { jamUpdateCommand } = await import("../../src/cli/update.js");
const { jamRefreshCommand, jamUninstallCommand } = await import("../../src/cli/lifecycle.js");
const { useRuntime } = await import("../../src/cli/runtime.js");
const { authLoginCommand, authLogoutCommand } = await import("../../src/cli/auth.js");
const { runJiraWrite } = await import("../../src/cli/jira-write.js");
const { setupAgentCommand, setupApplyCommand } = await import("../../src/cli/agent-api.js");

const MUTATORS = [
  setup,
  runSetupWizard,
  jamUpdateCommand,
  jamRefreshCommand,
  jamUninstallCommand,
  useRuntime,
  authLoginCommand,
  authLogoutCommand,
  runJiraWrite,
  setupAgentCommand,
  setupApplyCommand,
];

/** Every dispatcher path that can change configuration, registration, credentials or Jira. */
const MUTATING_COMMANDS: string[][] = [
  ["setup"],
  ["setup", "--agent"],
  ["setup", "plan"],
  ["setup", "apply"],
  ["setup", "--non-interactive"],
  ["update"],
  ["refresh"],
  ["uninstall"],
  ["runtime", "use", "package"],
  ["runtime", "use", "development", "/tmp/checkout"],
  ["auth", "login"],
  ["auth", "logout"],
  ["jira", "write-plan", "--operation", "issue.update", "--key", "X-1", "--input", "{}"],
  ["jira", "write-apply", "plan-1"],
];

let stdout: string;

beforeEach(() => {
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  for (const fn of MUTATORS) vi.mocked(fn).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a mutating command asked for help changes nothing", () => {
  for (const argv of MUTATING_COMMANDS) {
    for (const flag of ["--help", "-h"]) {
      it(`${["jam", ...argv, flag].join(" ")}`, async () => {
        const code = await runJamCommand([...argv, flag]);

        expect(code).toBe(0);
        expect(stdout).toBe(USAGE);
        for (const fn of MUTATORS) {
          expect(fn, `${fn.name} ran while the caller was asking for help`).not.toHaveBeenCalled();
        }
      });
    }
  }
});

describe("help still reaches the person, and the commands still work without it", () => {
  it("the top-level forms are unchanged", async () => {
    for (const argv of [["help"], ["--help"], ["-h"]]) {
      stdout = "";
      expect(await runJamCommand(argv)).toBe(0);
      expect(stdout).toBe(USAGE);
    }
  });

  it("without a help flag the command runs as before", async () => {
    await runJamCommand(["setup", "--non-interactive"]);
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it("the usage text names the commands it is documenting", () => {
    for (const word of ["jam setup", "jam update", "jam refresh", "jam uninstall", "jam auth login"]) {
      expect(USAGE).toContain(word);
    }
  });
});
