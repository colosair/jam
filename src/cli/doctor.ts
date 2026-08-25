import { buildDeps } from "../deps.js";
import { JamError, toJamError } from "../domain/errors.js";
import { createServer } from "../mcp/create-server.js";

type CheckResult = {
  name: string;
  ok: boolean;
  detail?: string;
};

/**
 * `jam doctor` exists to answer one question fast: is this a Jira problem, a
 * credential problem, or a local setup problem? Checks run in dependency order
 * and stop reporting downstream noise once a prerequisite fails.
 */
export async function doctor(): Promise<number> {
  const results: CheckResult[] = [];
  const line = (r: CheckResult) => {
    results.push(r);
    process.stdout.write(
      `${r.ok ? "[OK]  " : "[FAIL]"} ${r.name}${r.detail ? ` - ${r.detail}` : ""}\n`,
    );
  };

  // 1. Node runtime
  const major = Number(process.versions.node.split(".")[0]);
  line({
    name: "Node runtime",
    ok: major >= 20,
    detail: major >= 20 ? `v${process.versions.node}` : `v${process.versions.node} (need >= 20)`,
  });

  // 2. Project config + 3. credential presence
  let deps: Awaited<ReturnType<typeof buildDeps>>;
  try {
    deps = await buildDeps();
  } catch (err) {
    line({ name: "Project config", ok: false, detail: toJamError(err).message });
    return finish(results);
  }

  line({
    name: "Project config",
    ok: true,
    detail: deps.configPath
      ? `${deps.configPath} (project=${deps.config.project.key || "unset"})`
      : "using defaults (no .jira-agent/project.yaml found)",
  });

  if (!deps.config.project.key) {
    line({
      name: "Jira project key",
      ok: false,
      detail: "project.key is empty - set it in .jira-agent/project.yaml",
    });
  } else {
    line({ name: "Jira project key", ok: true, detail: deps.config.project.key });
  }

  const creds = deps.credentials.describe();
  const credsOk = Boolean(creds.baseUrl && creds.email && creds.hasToken);
  line({
    name: "Credentials present",
    ok: credsOk,
    // Never print the token itself - presence only.
    detail: credsOk
      ? `${creds.email} @ ${creds.baseUrl}`
      : "set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN",
  });

  // 4. Base URL shape
  const baseUrlOk = Boolean(creds.baseUrl && /^https?:\/\//.test(creds.baseUrl));
  line({
    name: "Jira base URL",
    ok: baseUrlOk,
    detail: baseUrlOk ? creds.baseUrl : "must start with http:// or https://",
  });

  // 5. MCP server construction - catches tool registration problems offline.
  try {
    createServer(deps);
    line({ name: "MCP server startup", ok: true, detail: "3 tools registered" });
  } catch (err) {
    line({ name: "MCP server startup", ok: false, detail: toJamError(err).message });
  }

  if (!credsOk || !baseUrlOk) {
    process.stdout.write("\nSkipping Jira connectivity checks - fix the above first.\n");
    return finish(results);
  }

  // 6. Authentication
  try {
    const me = await deps.jira.getCurrentUser();
    line({
      name: "Jira authentication",
      ok: true,
      detail: me.displayName ?? me.emailAddress ?? me.accountId,
    });
  } catch (err) {
    line({ name: "Jira authentication", ok: false, detail: describe(err) });
    return finish(results);
  }

  const projectKey = deps.config.project.key;
  if (!projectKey) return finish(results);

  // 7. JQL search endpoint + project permission
  let sampleKey: string | undefined;
  try {
    const page = await deps.jira.searchPage({
      jql: `project = "${projectKey}" ORDER BY updated DESC`,
      fields: ["summary", "status"],
      pageSize: 1,
    });
    sampleKey = page.issues[0]?.key;
    line({
      name: `JQL search / ${projectKey} access`,
      ok: true,
      detail: sampleKey ? `reachable (sample ${sampleKey})` : "reachable (project has no issues)",
    });
  } catch (err) {
    line({ name: `JQL search / ${projectKey} access`, ok: false, detail: describe(err) });
    return finish(results);
  }

  // 8. Issue detail endpoint
  if (!sampleKey) {
    process.stdout.write("[SKIP] Issue detail endpoint - no issue available to sample\n");
    return finish(results);
  }

  try {
    const batch = await deps.jira.getIssues({
      keys: [sampleKey],
      fields: ["summary", "status", "issuelinks"],
    });
    line({
      name: "Issue detail endpoint",
      ok: batch.issues.length === 1,
      detail: batch.issues.length === 1 ? `read ${sampleKey}` : `could not read ${sampleKey}`,
    });
  } catch (err) {
    line({ name: "Issue detail endpoint", ok: false, detail: describe(err) });
  }

  return finish(results);
}

function describe(err: unknown): string {
  const e = err instanceof JamError ? err : toJamError(err);
  return `${e.code}: ${e.message}`;
}

function finish(results: CheckResult[]): number {
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(
    failed.length === 0
      ? `\nAll ${results.length} checks passed.\n`
      : `\n${failed.length} of ${results.length} checks failed: ${failed.map((f) => f.name).join(", ")}\n`,
  );
  return failed.length === 0 ? 0 : 1;
}
