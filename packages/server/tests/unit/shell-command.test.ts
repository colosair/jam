import { describe, expect, it } from "vitest";
import { shellInvocation, stripPackageRunnerPath } from "../../src/bootstrap/shell-command.js";

/**
 * The two Windows lessons of the v1.4.2 field failure, held as contracts:
 * spawning npm shims must not regress into DEP0190 (args array + shell:true),
 * and "is jam installed" must never be answered by npx's ephemeral PATH.
 */
describe("shellInvocation", () => {
  it("POSIX: array argv, no shell", () => {
    expect(shellInvocation("claude", ["mcp", "list"], "linux")).toEqual({
      command: "claude",
      args: ["mcp", "list"],
      shell: false,
    });
  });

  it("win32: one joined line through a shell, empty args array (no DEP0190)", () => {
    expect(shellInvocation("claude", ["mcp", "add", "jam", "-s", "user"], "win32")).toEqual({
      command: "claude mcp add jam -s user",
      args: [],
      shell: true,
    });
  });

  it("win32: npm specs and pins stay joinable", () => {
    const { command } = shellInvocation("npx", ["--yes", "@jam-mcp/launcher@1.4.2", "serve"], "win32");
    expect(command).toBe("npx --yes @jam-mcp/launcher@1.4.2 serve");
  });

  it("win32: refuses tokens cmd.exe would re-interpret, naming the token", () => {
    for (const bad of ["a b", 'x"y', "a&b", "a|b", "a>b", "a;b", ""]) {
      expect(() => shellInvocation("claude", [bad], "win32")).toThrow(JSON.stringify(bad));
    }
  });
});

describe("stripPackageRunnerPath", () => {
  it("drops npx cache and node_modules/.bin entries, keeps the global npm bin", () => {
    const kept = "C:\\Users\\me\\AppData\\Roaming\\npm";
    const npx = "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\0729ee72\\node_modules\\.bin";
    const local = "C:\\work\\repo\\node_modules\\.bin";
    expect(stripPackageRunnerPath([npx, local, kept].join(";"), ";")).toBe(kept);
  });

  it("POSIX separators too", () => {
    const kept = "/usr/local/bin";
    const npx = "/home/me/.npm/_npx/abc123/node_modules/.bin";
    expect(stripPackageRunnerPath([npx, kept].join(":"), ":")).toBe(kept);
  });

  it("an entry that merely ends in node_modules is still a package-runner path", () => {
    expect(stripPackageRunnerPath("/a/node_modules:/usr/bin", ":")).toBe("/usr/bin");
  });

  it("leaves an ordinary PATH alone", () => {
    const value = "C:\\Windows\\system32;C:\\Program Files\\nodejs;C:\\Users\\me\\AppData\\Roaming\\npm";
    expect(stripPackageRunnerPath(value, ";")).toBe(value);
  });
});
