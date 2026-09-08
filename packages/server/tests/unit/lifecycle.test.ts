import { SERVER_VERSION } from "@jam-mcp/launcher";
import { describe, expect, it } from "vitest";

import {
  jamRefreshCommand,
  jamUninstallCommand,
  planRefresh,
  planUninstall,
} from "../../src/cli/lifecycle.js";
import type { HostCommand, HostRunResult, HostState } from "../../src/bootstrap/host-mcp.js";

/**
 * `refresh` and `uninstall` are the two lifecycle words JAM gained so both
 * products answer to the same vocabulary. What these hold is the boundary:
 * refresh does not move the version and does not touch a binding, and
 * uninstall removes registrations without taking the person's state with it.
 */

const claude = (over: Partial<HostState> = {}): HostState => ({
  id: "claude-code",
  cliAvailable: true,
  hasJamEntry: true,
  entryVersion: "1.4.6",
  ...over,
});

const ok = (stdout = ""): HostRunResult => ({ status: 0, failed: false, stdout });

function recorder(answers: (cmd: HostCommand) => HostRunResult) {
  const calls: HostCommand[] = [];
  return {
    calls,
    run: (cmd: HostCommand) => {
      calls.push(cmd);
      return answers(cmd);
    },
  };
}

describe("planRefresh", () => {
  it("a line pinned to another version is what refresh converges", () => {
    const plan = planRefresh([claude({ entryVersion: "1.4.6" })], "1.7.0");
    expect(plan.version).toBe("1.7.0");
    expect(plan.hosts[0]).toMatchObject({ id: "claude-code", from: "1.4.6", action: "repin" });
    expect(plan.steps).toEqual(["switch-registration", "verify"]);
  });

  it("a line already on this version is left alone", () => {
    const plan = planRefresh([claude({ entryVersion: "1.7.0" })], "1.7.0");
    expect(plan.hosts[0]?.action).toBe("none");
    expect(plan.steps).toEqual([]);
  });

  it("a bare entry runs the executable, so the line has nothing to move", () => {
    const plan = planRefresh([claude({ entryBare: true, entryVersion: "1.4.6" })], "1.7.0");
    expect(plan.hosts[0]?.action).toBe("none");
  });

  it("a host with no jam entry is not adopted here — that is setup", () => {
    expect(planRefresh([claude({ hasJamEntry: false })], "1.7.0").hosts).toEqual([]);
  });

  it("refresh never claims a version this build is not", () => {
    // The default is this build. Moving to something newer is `update`.
    expect(planRefresh([claude()]).version).toBe(SERVER_VERSION);
  });
});

describe("jam refresh", () => {
  it("check changes nothing", async () => {
    const rec = recorder(() => ok());
    const code = await jamRefreshCommand("check", {
      json: true,
      run: rec.run,
      hosts: () => [claude({ entryVersion: "0.0.1" })],
    });
    expect(code).toBe(0);
    expect(rec.calls).toEqual([]);
  });

  it("re-registers, then reads it back", async () => {
    let registered = false;
    const rec = recorder(() => ok());
    const code = await jamRefreshCommand(undefined, {
      run: (cmd) => {
        if (cmd.args.includes("add")) registered = true;
        return rec.run(cmd);
      },
      hosts: () =>
        registered ? [claude({ entryVersion: SERVER_VERSION })] : [claude({ entryVersion: "0.0.1" })],
    });
    expect(code).toBe(0);
    // The removal has to precede the re-pin — `mcp add` over an existing entry
    // changes nothing on Claude Code.
    const shapes = rec.calls.map((cmd) => cmd.args.join(" "));
    expect(shapes.some((line) => line.includes("remove"))).toBe(true);
    expect(shapes.some((line) => line.includes("add"))).toBe(true);
  });

  it("a registration it could not verify is not reported as done", async () => {
    const rec = recorder(() => ok());
    const code = await jamRefreshCommand(undefined, {
      run: rec.run,
      // The read-back still shows the old pin: something did not land.
      hosts: () => [claude({ entryVersion: "0.0.1" })],
    });
    expect(code).toBe(1);
  });
});

describe("planUninstall", () => {
  it("names the registrations to remove and the state that stays", () => {
    const plan = planUninstall([claude()], "1.5.0");
    expect(plan.hosts).toEqual(["claude-code"]);
    expect(plan.runtime).toBe("1.5.0");
    expect(plan.preserve.join("\n")).toMatch(/projects\.yaml/);
    expect(plan.preserve.join("\n")).toMatch(/credentials/);
  });

  it("with nothing installed globally there is no runtime to remove", () => {
    expect(planUninstall([claude()], null).runtime).toBeNull();
  });
});

describe("jam uninstall", () => {
  it("plan runs nothing that changes a host", async () => {
    const rec = recorder(() => ok("{}"));
    const code = await jamUninstallCommand("plan", {
      json: true,
      run: rec.run,
      hosts: () => [claude()],
    });
    expect(code).toBe(0);
    expect(rec.calls.every((cmd) => !cmd.args.includes("remove"))).toBe(true);
  });

  it("removes the registration and never the project binding", async () => {
    const rec = recorder(() => ok("{}"));
    const code = await jamUninstallCommand(undefined, { run: rec.run, hosts: () => [claude()] });
    expect(code).toBe(0);
    const lines = rec.calls.map((cmd) => [cmd.command, ...cmd.args].join(" "));
    expect(lines.some((line) => line.includes("remove"))).toBe(true);
    // Nothing here may reach the person's config or their Jira data.
    expect(lines.some((line) => /projects\.yaml|config\.yaml|\.jam/.test(line))).toBe(false);
    expect(lines.some((line) => /rm |rimraf|unlink/.test(line))).toBe(false);
  });
});
