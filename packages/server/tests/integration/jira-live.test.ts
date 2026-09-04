import { describe, expect, it } from "vitest";
import { buildDeps } from "../../src/deps.js";
import { getFullIssueContext } from "../../src/application/get-full-issue-context.js";
import { getIssueContext } from "../../src/application/get-issue-context.js";
import { searchIssues } from "../../src/application/search-issues.js";

/**
 * Opt-in: hits a real Jira. Enable with
 *   JAM_INTEGRATION=1 JIRA_BASE_URL=... JIRA_EMAIL=... JIRA_API_TOKEN=... npm test
 * The project key comes from .jira-agent/project.yaml.
 */
const enabled =
  process.env.JAM_INTEGRATION === "1" &&
  Boolean(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);

describe.skipIf(!enabled)("live Jira", () => {
  it("searches, then reads context and the full record for the first hit", async () => {
    const deps = await buildDeps();
    const projectKey = deps.config.project.key;
    expect(projectKey, "project.key must be set in .jira-agent/project.yaml").toBeTruthy();

    const search = await searchIssues(deps, {
      jql: `project = "${projectKey}" ORDER BY updated DESC`,
    });
    expect(search.meta.level).toBe("search");
    expect(search.meta.fetchedAt).toBeTruthy();

    const serialized = JSON.stringify(search.issues);
    expect(serialized).not.toContain('"description"');
    expect(serialized).not.toContain('"comments"');

    const firstKey = search.issues[0]?.key;
    if (!firstKey) return;

    // Identity, against a real Jira. `issueId` is what makes a reference
    // survive a key being moved, so "Jira sends it and JAM keeps it" is worth
    // asserting somewhere no fixture can be wrong about.
    const firstId = search.issues[0]?.issueId;
    expect(firstId, "Jira returns an id on every issue").toBeTruthy();
    // Jira ids are numeric strings. A key would fail this, which is the point:
    // the two must not be confusable.
    expect(firstId).toMatch(/^\d+$/);

    const context = await getIssueContext(deps, { issueKeys: [firstKey] });
    expect(context.meta.level).toBe("context");
    expect(context.issues[0]?.key).toBe(firstKey);
    expect(context.issues[0]).toHaveProperty("links");
    // The same issue read twice through different endpoints is the same issue.
    expect(context.issues[0]?.issueId).toBe(firstId);

    // Status category comes from Jira's own vocabulary, never from the status
    // name - which is why this asserts the value is one of Jira's and not that
    // it corresponds to anything the name says.
    const category = context.issues[0]?.statusCategory;
    if (category !== undefined) {
      expect(["new", "indeterminate", "done", "undefined"]).toContain(category);
    }

    // Nested references carry identity wherever Jira supplies it, and JAM
    // spends no request to fill in the ones it does not.
    for (const ref of [
      ...(context.issues[0]?.parent ? [context.issues[0].parent] : []),
      ...(context.issues[0]?.subtasks ?? []),
      ...(context.issues[0]?.links ?? []).map((l) => l.issue),
    ]) {
      expect(ref.key).toBeTruthy();
      if (ref.issueId !== undefined) expect(ref.issueId).toMatch(/^\d+$/);
    }

    const full = await getFullIssueContext(deps, { issueKeys: [firstKey] });
    expect(full.meta.level).toBe("full");
    expect(full.issues[0]?.issueId).toBe(firstId);
    expect(full.meta.commentsComplete).toBeDefined();
    expect(full.issues[0]).toHaveProperty("comments");
  }, 60_000);

  it("enumerates every page when scope=complete", async () => {
    const deps = await buildDeps();
    const projectKey = deps.config.project.key;

    const preview = await searchIssues(deps, { jql: `project = "${projectKey}"` });
    const complete = await searchIssues(deps, {
      jql: `project = "${projectKey}"`,
      scope: "complete",
    });

    expect(complete.issues.length).toBeGreaterThanOrEqual(preview.issues.length);
    if (complete.meta.complete) {
      const keys = new Set(complete.issues.map((i) => i.key));
      expect(keys.size).toBe(complete.issues.length);
    }
  }, 120_000);
});
