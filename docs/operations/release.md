# Releasing JAM

The procedure v1.0.1 and v1.1.0 actually used, written down so the next release
is the same one rather than a reconstruction.

## The one invariant

**A tag is created only after registry acceptance passes.**

A tag is a claim that the published artefacts work. Making it before the
published artefacts have been exercised inverts that: it says "this is the
release" about something nobody has run from the registry yet. npm versions are
immutable, so the order is the only thing that keeps a tag honest.

## The gate

```bash
npm run release:verify
```

That is `build`, `test`, `release:check`, `smoke`, in that order. It is the same
command CI runs on Ubuntu and Windows against Node 20 and 22, so a green local
run and a green CI run mean the same thing. `release:check` fails if the script
stops running any of the four.

The gate needs no Jira credentials and no network access to Jira. That is
deliberate: it answers whether the source is correct, not whether a Jira site is
reachable. Live acceptance is step 2 below, and it is a human's to run.

### What CI covers, and what it does not

`.github/workflows/ci.yml` runs `release:verify` on Ubuntu and Windows against
Node 20 and 22. Two things it deliberately does not decide:

- **Whether Jira is reachable.** No credentials are configured, and none are
  needed. A red build should mean the source is wrong, not that Atlassian is
  having an afternoon.
- **Host behaviour JAM delegates rather than implements.** Line editing in
  `jam auth login` is Node's `readline`, and Node changed it: given
  Ctrl-A, forward-delete, then a keystroke, Node 20 answers `bcZ` where Node 22
  answers `Zbc`. JAM's supported range stays `>=20`, and the suite still checks
  on every version what JAM owns - that the prompt runs a real line editor, so
  control sequences edit the buffer instead of ending up in the answer. The
  exact cursor placement is pinned only from Node 22, where it is stable. See
  `tests/unit/ui.test.ts`.

Test counts differ by platform, and that is expected: two Windows-only tests
cover the User environment credential source and case-insensitive path
handling, and one non-Windows test covers the platform check that keeps the
registry source from running elsewhere.

## Procedure

1. **`npm run release:verify`** — on at least one machine, and on both platforms
   when anything platform-shaped changed (paths, process spawning, shims,
   credentials).
2. **Platform acceptance where it is warranted.** `jam doctor` against live Jira,
   and whatever the change touched. Not in CI; see above.
3. **Publish, in dependency order:** `@jam-mcp/launcher`, then `@jam-mcp/server`,
   then `@jam-mcp/bootstrap`. They depend on each other at an exact version, so a
   consumer installing between two publishes must never be able to resolve a
   dependency that does not exist yet.
4. **Confirm the registry has them:** `npm view @jam-mcp/<pkg> version` for all
   three.
5. **Registry acceptance** — from the published packages, never a local build:
   - `@jam-mcp/bootstrap@<version>` from a zero state returns machine-readable
     JSON and a `nextAction.command` that runs on a machine with no JAM on it
   - `@jam-mcp/launcher@<version>` in package mode reaches
     `@jam-mcp/server@<version>` over stdio
   - `serverInfo` reports `jam` at the release version, and five tools:
     `jira_search`, `jira_context`, `jira_full`, `jira_write_plan`,
     `jira_write_apply`
   - a live Jira read carries `meta.source`, `meta.provenance`,
     `meta.evidenceScope` and `meta.limitations`
   - a write against a dedicated test issue plans, applies, verifies by direct
     read, and is restored the same way
   - a key outside the configured project is refused at plan time
6. **Tag** the release commit and push the tag.
7. **GitHub Release** against that tag.

Publishing stays a human step. CI is automatic; `npm publish` is not. An npm
version cannot be taken back, the release cadence is low, and the manual cost is
small — that trade will be worth revisiting when the cadence changes, together
with provenance and trusted publishing.

## What "zero state" means

"Zero state" is four separate claims, and an acceptance run usually proves some
of them and not others. Say which.

| Term | What it claims |
| --- | --- |
| `zero-install` | No JAM installed globally, and no dependency on a local checkout |
| `zero-config` | No `~/.jam` configuration present |
| `zero-binding` | No project binding for this workspace, in the repository or in `~/.jam/projects.yaml` |
| `zero-credentials` | Every credential provider returns nothing |

The first three are properties of a directory and a home directory, so a
sandbox that repoints `HOME` establishes them. `zero-credentials` is not:

- the **OS secret store** is per-user, not per-`HOME`
- on Windows, the **User environment** in `HKCU\Environment` is per-user too, so
  a developer who once ran `setx JIRA_API_TOKEN` has credentials every process
  of theirs can see

So on Windows, **zero `HOME` is not zero credentials**. The v1.1.0 registry
acceptance run established `zero-install`, `zero-config` and `zero-binding`; it
did not establish `zero-credentials`, because the Windows User environment
supplied a token to a sandbox that had none of its own. That result stands as
recorded — it proved what it proved.

Tests and sandboxes reach `zero-credentials` with two switches, which exist for
this and are never set in production:

- `JAM_DISABLE_SECRET_STORE=1`
- `JAM_DISABLE_USER_ENV=1`

`packages/server/tests/setup-env.ts` sets both, and clears `JIRA_*`, for the
whole suite — so a developer's machine reads like CI, where there is genuinely
nothing to find. The integration suite is exempt, since reaching real
credentials is the point of it; it is opt-in through `JAM_INTEGRATION`.
