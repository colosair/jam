import { spawn } from "node:child_process";
import { SERVER_VERSION } from "@jam-mcp/launcher";
import { TOOL_NAMES } from "../mcp/create-server.js";

/**
 * What the registered entry actually serves.
 *
 * Counting the tools of the process doing the counting proves nothing about
 * the agent's experience: the agent talks to whatever the host registration
 * launches, which may be an older release with a different tool set. This asks
 * that process directly, over the protocol the agent uses.
 */
export type LiveToolsetVerdict = "OK" | "LIVE_TOOLSET_MISMATCH" | "UNREACHABLE";

export type LiveToolsetResult = {
  verdict: LiveToolsetVerdict;
  expected: string[];
  actual?: string[];
  missing?: string[];
  detail?: string;
};

export type ToolsetProbe = (argv: {
  command: string;
  args: string[];
}) => Promise<string[] | null>;

const HANDSHAKE_TIMEOUT_MS = 30_000;

export const expectedTools = (): string[] => [...TOOL_NAMES].sort();

/**
 * Speak just enough MCP to ask for the tool list: initialize, initialized,
 * tools/list. A full client would pull in the SDK's transport machinery for
 * one question that is three lines of JSON.
 */
export const defaultToolsetProbe: ToolsetProbe = ({ command, args }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "ignore"],
      shell: process.platform === "win32",
    });

    let buffer = "";
    let settled = false;
    const done = (value: string[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), HANDSHAKE_TIMEOUT_MS);

    child.on("error", () => done(null));
    child.on("exit", () => done(null));
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const message = JSON.parse(line) as {
            id?: number;
            result?: { tools?: { name: string }[] };
          };
          if (message.id === 2) {
            done((message.result?.tools ?? []).map((tool) => tool.name).sort());
            return;
          }
        } catch {
          // Not our line. The server owns stdout for the protocol; anything
          // unparseable is noise from a wrapper and is skipped rather than
          // treated as a failure.
        }
      }
    });

    const send = (payload: unknown): void => {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "jam-doctor", version: SERVER_VERSION },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  });

/**
 * Compare what the registered command serves against what this release
 * defines. A tool the agent cannot see is a tool it does not have, whatever
 * the package on disk says.
 */
export async function checkLiveToolset(
  argv: { command: string; args: string[] },
  probe: ToolsetProbe = defaultToolsetProbe,
): Promise<LiveToolsetResult> {
  const expected = expectedTools();
  const actual = await probe(argv).catch(() => null);
  if (actual === null) {
    return { verdict: "UNREACHABLE", expected, detail: "the registered command did not answer tools/list" };
  }
  const missing = expected.filter((name) => !actual.includes(name));
  if (missing.length > 0) {
    return { verdict: "LIVE_TOOLSET_MISMATCH", expected, actual, missing };
  }
  return { verdict: "OK", expected, actual };
}
