import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { dispatch, type SpawnFn } from "../src/dispatch.js";
import type { ResolvedRuntime } from "../src/runtime-resolver.js";

const PACKAGE_RUNTIME: ResolvedRuntime = {
  mode: "package",
  version: "1.0.0",
  executable: { command: "npx", args: ["--yes", "@jam-mcp/server@1.0.0"] },
};

const DEV_RUNTIME: ResolvedRuntime = {
  mode: "development",
  version: "1.0.0",
  executable: { command: "/usr/bin/node", args: ["/src/packages/server/dist/index.js"] },
};

type Call = { command: string; args: string[]; options: Record<string, unknown> };

/** Minimal stand-in for a spawned child, so dispatch can be driven deterministically. */
class FakeChild extends EventEmitter {
  killed = false;
  killedWith?: NodeJS.Signals;
  kill(signal?: NodeJS.Signals) {
    this.killed = true;
    this.killedWith = signal;
    return true;
  }
}

function fakeSpawn(): { spawnFn: SpawnFn; calls: Call[]; child: FakeChild } {
  const calls: Call[] = [];
  const child = new FakeChild();
  const spawnFn = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    return child as never;
  }) as SpawnFn;
  return { spawnFn, calls, child };
}

describe("dispatch", () => {
  it("appends the caller's argv to the runtime command and forwards cwd", async () => {
    const { spawnFn, calls, child } = fakeSpawn();
    const promise = dispatch(PACKAGE_RUNTIME, ["serve"], { cwd: "/work/project", spawnFn });
    child.emit("exit", 0, null);

    await promise;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("npx");
    expect(calls[0]?.args).toEqual(["--yes", "@jam-mcp/server@1.0.0", "serve"]);
    expect(calls[0]?.options.cwd).toBe("/work/project");
  });

  it("inherits stdio so stdout stays the child's MCP channel", async () => {
    const { spawnFn, calls, child } = fakeSpawn();
    const promise = dispatch(DEV_RUNTIME, ["serve"], { spawnFn });
    child.emit("exit", 0, null);

    await promise;
    expect(calls[0]?.options.stdio).toBe("inherit");
  });

  it("propagates the child's exit code", async () => {
    const { spawnFn, child } = fakeSpawn();
    const promise = dispatch(DEV_RUNTIME, ["serve"], { spawnFn });
    child.emit("exit", 3, null);

    expect(await promise).toBe(3);
  });

  it("reports a signalled death as 128 + signal, not as success", async () => {
    const { spawnFn, child } = fakeSpawn();
    const promise = dispatch(DEV_RUNTIME, ["serve"], { spawnFn });
    child.emit("exit", null, "SIGINT");

    expect(await promise).toBe(130);
  });

  it("forwards a terminating signal to the child", async () => {
    const { spawnFn, child } = fakeSpawn();
    const promise = dispatch(DEV_RUNTIME, ["serve"], { spawnFn });

    process.emit("SIGTERM");
    expect(child.killed).toBe(true);
    expect(child.killedWith).toBe("SIGTERM");

    child.emit("exit", 0, null);
    await promise;
  });

  it("stops listening for signals once the child is gone", async () => {
    const before = process.listenerCount("SIGTERM");
    const { spawnFn, child } = fakeSpawn();
    const promise = dispatch(DEV_RUNTIME, ["serve"], { spawnFn });
    child.emit("exit", 0, null);
    await promise;

    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("turns a spawn failure into a launcher error naming the runtime", async () => {
    const { spawnFn, child } = fakeSpawn();
    const promise = dispatch(PACKAGE_RUNTIME, ["serve"], { spawnFn });
    child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    await expect(promise).rejects.toMatchObject({ code: "JAM_PACKAGE_RUNTIME_FAILED" });
  });
});
