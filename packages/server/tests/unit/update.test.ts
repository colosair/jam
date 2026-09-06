import { describe, expect, it } from "vitest";

import {
  jamUpdateCommand,
  planJamUpdate,
  UPDATE_ORDER,
  type HostFacts,
} from "../../src/cli/update.js";
import type { HostCommand, HostRunResult } from "../../src/bootstrap/host-mcp.js";

/**
 * What goes stale in JAM is the registration line, not a directory. These hold
 * the two properties that make an update safe: the new pin is proven to answer
 * before anything is re-registered, and setup is never re-run.
 */

const claude = (over: Partial<HostFacts> = {}): HostFacts => ({
  id: "claude-code",
  cliAvailable: true,
  hasJamEntry: true,
  entryVersion: "1.4.6",
  ...over,
});

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

const ok = (stdout = ""): HostRunResult => ({ status: 0, failed: false, stdout });

describe("planJamUpdate", () => {
  it("a stale pin is what makes an update available", () => {
    const plan = planJamUpdate({ latest: "1.5.0", hosts: [claude({ entryVersion: "1.4.6" })] });
    expect(plan.state).toBe("UPDATE_AVAILABLE");
    expect(plan.hosts[0]).toMatchObject({ id: "claude-code", from: "1.4.6", action: "repin" });
    expect(plan.steps).toEqual([...UPDATE_ORDER]);
  });

  it("a host with no jam entry is left alone", () => {
    // Registering JAM somewhere it was never registered is adoption, not an update.
    const plan = planJamUpdate({ latest: "1.5.0", hosts: [claude({ hasJamEntry: false })] });
    expect(plan.state).toBe("CURRENT");
    expect(plan.hosts).toEqual([]);
  });

  it("an unreadable entry is not reported as current", () => {
    const plan = planJamUpdate({ latest: "1.5.0", hosts: [claude({ entryVersion: undefined })] });
    expect(plan.state).toBe("BROKEN");
  });

  it("without the registry it claims nothing", () => {
    const plan = planJamUpdate({ hosts: [claude()] });
    expect(plan.state).toBe("UNKNOWN");
    expect(plan.steps).toEqual([]);
  });

  it("verification comes before the switch, and nothing is removed first", () => {
    expect(UPDATE_ORDER.indexOf("verify-install")).toBeLessThan(
      UPDATE_ORDER.indexOf("switch-registration"),
    );
    expect(UPDATE_ORDER.filter((step) => /remove|delete|uninstall/.test(step))).toEqual([]);
  });
});

describe("jam update", () => {
  it("check runs nothing", async () => {
    const { run, calls } = recorder(() => ok());
    const code = await jamUpdateCommand("check", {
      run,
      json: true,
      latest: () => "1.5.0",
      hosts: () => [claude()],
    });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
  });

  it("a pin that does not answer is never registered", async () => {
    // The whole order exists for this case: the host keeps running what it ran.
    const { run, calls } = recorder((cmd) =>
      cmd.command === "npx" ? { status: 1, failed: false, stdout: "" } : ok(),
    );
    const code = await jamUpdateCommand(undefined, {
      run,
      latest: () => "1.5.0",
      hosts: () => [claude({ entryVersion: "1.4.6" })],
    });
    expect(code).toBe(1);
    expect(calls.some((cmd) => cmd.args.includes("remove"))).toBe(false);
    expect(calls.some((cmd) => cmd.args.includes("add"))).toBe(false);
  });

  it("re-pins the entry once the new build answers, then reads it back", async () => {
    let registered = "1.4.6";
    const { run, calls } = recorder((cmd) => {
      if (cmd.command === "npx") {
        // Two different questions go through the same pinned launcher: does it
        // answer at all, and is it healthy once registered.
        return cmd.args.includes("doctor")
          ? ok(JSON.stringify({ status: "ready" }))
          : ok(JSON.stringify({ version: "1.5.0" }));
      }
      if (cmd.args.includes("add")) {
        registered = "1.5.0";
        return ok();
      }
      return ok();
    });
    const code = await jamUpdateCommand(undefined, {
      run,
      latest: () => "1.5.0",
      hosts: () => [claude({ entryVersion: registered })],
    });
    expect(code).toBe(0);
    // remove precedes add: `mcp add` over an existing entry changes nothing.
    const removeAt = calls.findIndex((cmd) => cmd.args.includes("remove"));
    const addAt = calls.findIndex((cmd) => cmd.args.includes("add"));
    expect(removeAt).toBeGreaterThanOrEqual(0);
    expect(removeAt).toBeLessThan(addAt);
    expect(calls[addAt]?.args.join(" ")).toContain("@jam-mcp/launcher@1.5.0");
  });

  it("never re-runs setup", async () => {
    const { run, calls } = recorder((cmd) =>
      cmd.command === "npx"
        ? ok(JSON.stringify(cmd.args.includes("doctor") ? { status: "ready" } : { version: "1.5.0" }))
        : ok(),
    );
    await jamUpdateCommand(undefined, {
      run,
      latest: () => "1.5.0",
      hosts: () => [claude({ entryVersion: "1.5.0" })],
    });
    expect(calls.some((cmd) => cmd.args.includes("setup"))).toBe(false);
  });

  it("a build that is registered but not healthy is rolled back", async () => {
    // Registration landing is not the same as JAM working. doctor is the axis
    // that knows the difference, so a failing one undoes the re-pin.
    let registered = "1.4.6";
    const { run, calls } = recorder((cmd) => {
      if (cmd.command === "npx") {
        return cmd.args.includes("doctor")
          ? ok(JSON.stringify({ status: "blocked" }))
          : ok(JSON.stringify({ version: "1.5.0" }));
      }
      if (cmd.args.includes("add")) registered = "1.5.0";
      return ok();
    });
    const code = await jamUpdateCommand(undefined, {
      run,
      latest: () => "1.5.0",
      hosts: () => [claude({ entryVersion: registered })],
    });
    expect(code).toBe(1);
    const registrations = calls.filter((cmd) => cmd.args.includes("add")).map((cmd) => cmd.args.join(" "));
    expect(registrations.at(-1)).toContain("@jam-mcp/launcher@1.4.6");
  });
});
