import { platform } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalRemote, workspaceIdentity } from "../../src/bootstrap/workspace-identity.js";

const remote = (url: string) => () => url;

describe("canonicalRemote", () => {
  it("gives one repository one identity, whichever URL form was cloned", () => {
    const expected = "github.com/acme/web";
    for (const url of [
      "git@github.com:acme/web.git",
      "https://github.com/acme/web.git",
      "https://github.com/acme/web",
      "https://github.com/acme/web/",
      "ssh://git@github.com/acme/web.git",
      "https://GitHub.com/Acme/Web.git",
    ]) {
      expect(canonicalRemote(url), url).toBe(expected);
    }
  });

  it("never carries userinfo into the identity", () => {
    const id = canonicalRemote("https://someone:ghp_notarealtoken@github.com/acme/web.git");

    expect(id).toBe("github.com/acme/web");
    expect(id).not.toContain("ghp_");
    expect(id).not.toContain("someone");
  });

  it("keeps an explicit non-default port, because it can be a different service", () => {
    // Self-hosted GitLab on a non-standard port is ordinary, and collapsing it
    // into the bare host would bind two different repos to one entry.
    expect(canonicalRemote("https://git.example.com:8443/acme/web.git")).toBe(
      "git.example.com:8443/acme/web",
    );
    expect(canonicalRemote("https://git.example.com:8443/acme/web")).not.toBe(
      canonicalRemote("https://git.example.com/acme/web"),
    );
  });

  it("drops a port that is the scheme's own default", () => {
    expect(canonicalRemote("https://git.example.com:443/acme/web")).toBe(
      canonicalRemote("https://git.example.com/acme/web"),
    );
    expect(canonicalRemote("ssh://git@git.example.com:22/acme/web.git")).toBe(
      "git.example.com/acme/web",
    );
  });

  it("reads the scp form's colon as a path separator, not a port", () => {
    expect(canonicalRemote("git@git.example.com:acme/web.git")).toBe("git.example.com/acme/web");
    expect(canonicalRemote("git@git.example.com:8443/acme/web.git")).toBe(
      "git.example.com/8443/acme/web",
    );
  });

  it("returns nothing it cannot canonicalise", () => {
    for (const url of ["", "   ", "not a url", "https://"]) {
      expect(canonicalRemote(url), url).toBeUndefined();
    }
  });
});

describe("workspaceIdentity", () => {
  const repo = resolve("/tmp/checkouts/web");

  it("is the same for two clones of one repository at different paths", () => {
    const here = workspaceIdentity(repo, {
      gitRoot: repo,
      git: remote("git@github.com:acme/web.git"),
    });
    const there = workspaceIdentity(resolve("/other/place/web-2"), {
      gitRoot: resolve("/other/place/web-2"),
      git: remote("https://github.com/acme/web"),
    });

    expect(here).toBe("git:github.com/acme/web");
    expect(there).toBe(here);
  });

  it("distinguishes packages inside one repository", () => {
    const id = workspaceIdentity(join(repo, "packages", "api"), {
      gitRoot: repo,
      git: remote("git@github.com:acme/web.git"),
    });

    expect(id).toBe("git:github.com/acme/web#packages/api");
    expect(id).not.toBe(
      workspaceIdentity(join(repo, "packages", "worker"), {
        gitRoot: repo,
        git: remote("git@github.com:acme/web.git"),
      }),
    );
  });

  it("falls back to a normalised path when there is no remote to ask about", () => {
    const id = workspaceIdentity(repo, { gitRoot: repo, git: () => undefined });

    expect(id.startsWith("path:")).toBe(true);
    expect(id).not.toContain("\\");
    if (platform() === "win32") expect(id).toBe(id.toLowerCase());
  });

  it("falls back the same way outside a repository, without asking git at all", () => {
    let asked = 0;
    const id = workspaceIdentity(repo, {
      git: () => {
        asked++;
        return "git@github.com:acme/web.git";
      },
    });

    expect(asked).toBe(0);
    expect(id.startsWith("path:")).toBe(true);
  });
});
