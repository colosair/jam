import type { JamDeps } from "../deps.js";
import { toJamError } from "../domain/errors.js";
import { createServer } from "../mcp/create-server.js";

export type HealthCheck = {
  name: string;
  ok: boolean;
  /** A failed fatal check blocks MCP startup; a non-fatal one is a warning. */
  fatal: boolean;
  detail?: string;
};

export type GateMode = "boot" | "full";

export type GateResult = {
  mode: GateMode;
  checks: HealthCheck[];
  passed: boolean;
};

/**
 * One health-check core shared by `jam doctor`, `jam setup` and `jam serve`.
 *
 * "boot" mode is what `jam serve` runs on every startup: local checks only
 * (Node version, config, credentials, base URL shape, MCP wiring) - no network
 * round trip, so it never adds Jira's latency to Claude Code's own startup.
 * "full" mode adds live Jira connectivity checks and is what `jam doctor` and
 * `jam setup` run, since those are explicit, occasional diagnostics rather
 * than something on the hot path of every session.
 */
export async function runHealthGate(deps: JamDeps, mode: GateMode): Promise<GateResult> {
  const checks: HealthCheck[] = [];
  const add = (c: HealthCheck) => checks.push(c);

  const major = Number(process.versions.node.split(".")[0]);
  add({
    name: "Node runtime",
    ok: major >= 20,
    fatal: true,
    detail: major >= 20 ? `v${process.versions.node}` : `v${process.versions.node} (need >= 20)`,
  });

  add({
    name: "Project config",
    ok: true,
    fatal: true,
    // Three states, not two: a project with no config file may still have a
    // key, supplied for this run only. Saying "using defaults" there would
    // report the opposite of what JAM is about to do.
    detail: deps.configPath
      ? `${deps.configPath} (project=${deps.config.project.key || "unset"})`
      : deps.keySource
        ? `no project.yaml - project=${deps.config.project.key} from ${deps.keySource}`
        : "using defaults (no .jira-agent/project.yaml found)",
  });

  const hasKey = Boolean(deps.config.project.key);
  add({
    name: "Jira project key",
    ok: hasKey,
    fatal: true,
    detail: hasKey ? deps.config.project.key : "not set - run `jam setup --project <KEY>`",
  });

  const creds = deps.credentials.describe();
  const credsOk = Boolean(creds.baseUrl && creds.email && creds.hasToken);
  add({
    name: "Credentials present",
    ok: credsOk,
    fatal: true,
    // Never print the token itself - presence and source only.
    detail: credsOk
      ? `${creds.email} @ ${creds.baseUrl} (${creds.source})`
      : "run `jam auth login`, or set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN",
  });

  const baseUrlOk = Boolean(creds.baseUrl && /^https?:\/\//.test(creds.baseUrl));
  add({
    name: "Jira base URL",
    ok: baseUrlOk,
    fatal: true,
    detail: baseUrlOk ? creds.baseUrl! : "must start with http:// or https://",
  });

  try {
    createServer(deps);
    add({ name: "MCP server startup", ok: true, fatal: true, detail: "3 tools registered" });
  } catch (err) {
    add({ name: "MCP server startup", ok: false, fatal: true, detail: toJamError(err).message });
  }

  const bootFatalFailed = checks.some((c) => c.fatal && !c.ok);
  if (mode === "boot" || bootFatalFailed) {
    return { mode, checks, passed: !bootFatalFailed };
  }

  // full mode: live Jira connectivity, only reached once every boot-level check passed.
  try {
    const me = await deps.jira.getCurrentUser();
    add({
      name: "Jira authentication",
      ok: true,
      fatal: true,
      detail: me.displayName ?? me.emailAddress ?? me.accountId,
    });
  } catch (err) {
    add({ name: "Jira authentication", ok: false, fatal: true, detail: describeErr(err) });
    return { mode, checks, passed: false };
  }

  const projectKey = deps.config.project.key;
  let sampleKey: string | undefined;
  try {
    const page = await deps.jira.searchPage({
      jql: `project = "${projectKey}" ORDER BY updated DESC`,
      fields: ["summary", "status"],
      pageSize: 1,
    });
    sampleKey = page.issues[0]?.key;
    add({
      name: `JQL search / ${projectKey} access`,
      ok: true,
      fatal: true,
      detail: sampleKey ? `reachable (sample ${sampleKey})` : "reachable (project has no issues)",
    });
  } catch (err) {
    add({ name: `JQL search / ${projectKey} access`, ok: false, fatal: true, detail: describeErr(err) });
    return { mode, checks, passed: false };
  }

  if (sampleKey) {
    try {
      const batch = await deps.jira.getIssues({
        keys: [sampleKey],
        fields: ["summary", "status", "issuelinks"],
      });
      add({
        name: "Issue detail endpoint",
        ok: batch.issues.length === 1,
        fatal: false,
        detail: batch.issues.length === 1 ? `read ${sampleKey}` : `could not read ${sampleKey}`,
      });
    } catch (err) {
      add({ name: "Issue detail endpoint", ok: false, fatal: false, detail: describeErr(err) });
    }
  } else {
    add({
      name: "Issue detail endpoint",
      ok: true,
      fatal: false,
      detail: "skipped - no issue available to sample",
    });
  }

  const anyFatalFailed = checks.some((c) => c.fatal && !c.ok);
  return { mode, checks, passed: !anyFatalFailed };
}

function describeErr(err: unknown): string {
  const e = toJamError(err);
  return `${e.code}: ${e.message}`;
}
