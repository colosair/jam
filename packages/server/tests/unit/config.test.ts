import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findConfigPath, loadConfig } from "../../src/config/load-config.js";
import { ProjectConfigSchema } from "../../src/config/schema.js";

function projectDir(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), "jam-config-"));
  mkdirSync(join(root, ".jira-agent"), { recursive: true });
  writeFileSync(join(root, ".jira-agent", "project.yaml"), yaml, "utf8");
  return root;
}

describe("ProjectConfigSchema", () => {
  it("fills in defaults for an almost-empty config", () => {
    const config = ProjectConfigSchema.parse({ project: { key: "PROJECT" } });
    expect(config.search.pageSize).toBe(50);
    expect(config.fields.lite).toContain("summary");
    expect(config.output.fullTokens).toBe(8000);
    expect(config.policy.fullRequiredFor).toContain("approval");
  });

  it("rejects a custom field id that is not a Jira custom field", () => {
    const result = ProjectConfigSchema.safeParse({
      project: { key: "PROJECT" },
      customFields: [{ id: "summary", name: "Summary" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("loadConfig", () => {
  it("finds .jira-agent/project.yaml by walking up from a subdirectory", () => {
    const root = projectDir("version: 1\nproject:\n  key: PROJECT\n");
    const nested = join(root, "src", "deep");
    mkdirSync(nested, { recursive: true });

    expect(findConfigPath(nested)).toBe(join(root, ".jira-agent", "project.yaml"));
    expect(loadConfig(nested).config.project.key).toBe("PROJECT");
  });

  it("falls back to defaults when there is no config at all", () => {
    const empty = mkdtempSync(join(tmpdir(), "jam-empty-"));
    const loaded = loadConfig(empty);
    expect(loaded.path).toBeUndefined();
    expect(loaded.config.project.key).toBe("");
  });

  it("refuses to start on a malformed config rather than guessing", () => {
    const root = projectDir("version: 1\nsearch:\n  pageSize: 5000\n");
    expect(() => loadConfig(root)).toThrowError(/CONFIG|pageSize|Invalid/i);
  });

  it("refuses to start on unparseable YAML", () => {
    const root = projectDir("project:\n  key: [unclosed\n");
    expect(() => loadConfig(root)).toThrowError(/Could not parse/);
  });
});
