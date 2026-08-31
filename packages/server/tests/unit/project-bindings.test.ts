import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../support/temp.js";
import { describe, expect, it } from "vitest";
import {
  findProjectBinding,
  inspectProjectBindings,
  projectBindingsPath,
  readProjectBindings,
  writeProjectBinding,
} from "../../src/bootstrap/project-bindings.js";
import { snapshot } from "../helpers.js";

function home(): string {
  return tempDir("jam-bindhome-");
}

function withBindings(contents: string): string {
  const dir = home();
  mkdirSync(join(dir, ".jam"), { recursive: true });
  writeFileSync(projectBindingsPath(dir), contents, "utf8");
  return dir;
}

describe("project bindings", () => {
  it("treats a missing file as no bindings, and creates nothing by looking", () => {
    const dir = home();
    const before = snapshot(dir);

    const inspection = inspectProjectBindings(dir);

    expect(inspection.status).toBe("absent");
    expect(inspection.bindings).toEqual([]);
    // detect() must stay free of writes, and this is the read it makes.
    expect(snapshot(dir)).toEqual(before);
  });

  it("round-trips a binding and preserves the ones it did not touch", () => {
    const dir = withBindings(
      [
        "version: 1",
        "bindings:",
        '  - workspace: "git:github.com/acme/other"',
        "    key: OTHER",
        "",
      ].join("\n"),
    );

    writeProjectBinding({ workspace: "git:github.com/acme/web", key: "WEB", path: "C:\\dev\\web" }, dir);

    const bindings = readProjectBindings(dir);
    expect(bindings).toHaveLength(2);
    expect(findProjectBinding("git:github.com/acme/other", dir)?.key).toBe("OTHER");
    expect(findProjectBinding("git:github.com/acme/web", dir)).toEqual({
      workspace: "git:github.com/acme/web",
      key: "WEB",
      path: "C:\\dev\\web",
    });
  });

  it("replaces the binding for a workspace rather than adding a second one", () => {
    const dir = home();
    writeProjectBinding({ workspace: "git:github.com/acme/web", key: "OLD" }, dir);
    writeProjectBinding({ workspace: "git:github.com/acme/web", key: "NEW" }, dir);

    expect(readProjectBindings(dir)).toEqual([
      { workspace: "git:github.com/acme/web", key: "NEW" },
    ]);
  });

  it("refuses to rewrite a file it could not read, and leaves it byte-identical", () => {
    const damaged = "version: 1\nbindings: [ this is not: valid: yaml\n";
    const dir = withBindings(damaged);
    const before = snapshot(dir);

    expect(() => writeProjectBinding({ workspace: "git:x/y", key: "K" }, dir)).toThrowError(
      expect.objectContaining({ code: "JAM_BINDINGS_UNREADABLE" }),
    );

    // Rewriting from an empty list would have destroyed whatever is still in
    // there - which is exactly what a damaged file might be hiding.
    expect(snapshot(dir)).toEqual(before);
    expect(readFileSync(projectBindingsPath(dir), "utf8")).toBe(damaged);
  });

  it("treats a version it does not understand the same way", () => {
    const dir = withBindings("version: 99\nbindings: []\n");

    expect(inspectProjectBindings(dir).status).toBe("unreadable");
    expect(() => writeProjectBinding({ workspace: "git:x/y", key: "K" }, dir)).toThrowError(
      expect.objectContaining({ code: "JAM_BINDINGS_UNREADABLE" }),
    );
    // Discovery still shrugs: a command that only reads must not fail here.
    expect(readProjectBindings(dir)).toEqual([]);
  });

  it("skips entries that are not a workspace/key pair instead of failing", () => {
    const dir = withBindings(
      ["version: 1", "bindings:", "  - key: NOWORKSPACE", "  - workspace: git:x/y", ""].join("\n"),
    );

    expect(inspectProjectBindings(dir).status).toBe("parsed");
    expect(readProjectBindings(dir)).toEqual([]);
  });

  it("treats an emptied-out list as empty, not as damaged", () => {
    // What a person is left with after deleting the last entry by hand.
    const dir = withBindings(["version: 1", "bindings:", ""].join("\n"));

    expect(inspectProjectBindings(dir).status).toBe("parsed");
    expect(() => writeProjectBinding({ workspace: "git:x/y", key: "K" }, dir)).not.toThrow();
    expect(readProjectBindings(dir)).toEqual([{ workspace: "git:x/y", key: "K" }]);
  });

  it("never writes credential material", () => {
    const dir = home();
    writeProjectBinding({ workspace: "git:github.com/acme/web", key: "WEB" }, dir);

    const written = readFileSync(projectBindingsPath(dir), "utf8");
    expect(written).not.toMatch(/token|password|secret|@/i);
    expect(written).toContain("Never put Jira credentials here.");
  });
});
