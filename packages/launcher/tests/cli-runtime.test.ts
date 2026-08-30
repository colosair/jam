import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { readRuntimeConfig } from "../src/runtime-config.js";

/**
 * The launcher answers `runtime` itself, before any dispatch.
 *
 * That is what makes a persistent install self-sufficient: `runtime use
 * package` is the command that CREATES ~/.jam/config.yaml, so it cannot be
 * forwarded to a runtime that is only reachable once that file exists. A
 * fresh machine with only `npm install -g @jam-mcp/launcher` used to be stuck
 * exactly there.
 */

function sandboxHome(): string {
  const home = mkdtempSync(join(tmpdir(), "jam-launcher-home-"));
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  return home;
}

describe("launcher-handled runtime group", () => {
  let home: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    home = sandboxHome();
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    return () => vi.restoreAllMocks();
  });

  it("`runtime use package` works with no config present — no chicken-and-egg", async () => {
    const code = await run(["runtime", "use", "package"]);

    expect(code).toBe(0);
    expect(readRuntimeConfig(home)?.runtime.mode).toBe("package");
    // homedir() is what production reads; the sandbox repointed it.
    expect(homedir()).toBe(home);
  });

  it("`runtime status --json` on a fresh machine says not_configured, exit 1", async () => {
    const code = await run(["runtime", "status", "--json"]);

    expect(code).toBe(1);
    const payload = JSON.parse(stdout.join("")) as { status: string; nextCommand: string };
    expect(payload.status).toBe("not_configured");
    expect(payload.nextCommand).toContain("runtime use package");
  });

  it("after `use package`, status reports what would actually run", async () => {
    await run(["runtime", "use", "package"]);
    stdout.length = 0;

    const code = await run(["runtime", "status", "--json"]);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join("")) as {
      status: string;
      mode: string;
      executable: { command: string; args: string[] };
    };
    expect(payload.status).toBe("configured");
    expect(payload.mode).toBe("package");
    // In this workspace the server is installed next to the launcher, so the
    // executable is a direct node invocation — the persistent contract.
    expect(payload.executable.command).toBe(process.execPath);
    expect(payload.executable.args[0]).toMatch(/index\.js$/);
  });

  it("`use development` validates the checkout before recording it", async () => {
    const code = await run(["runtime", "use", "development", join(home, "nowhere")]);

    expect(code).toBe(1);
    expect(readRuntimeConfig(home)).toBeUndefined();
    expect(stderr.join("")).toContain("JAM_");
  });

  it("config.yaml stays free of anything secret-shaped", async () => {
    await run(["runtime", "use", "package"]);

    const written = readFileSync(join(home, ".jam", "config.yaml"), "utf8");
    expect(written).not.toMatch(/token|password|secret|JIRA_API/i);
  });
});
