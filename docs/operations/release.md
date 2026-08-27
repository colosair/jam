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
6. **Two-URL zero-base acceptance** — the agent-installability claim, which no
   automated gate can make. The smoke gate proves the machinery works; this
   proves an agent that has never seen JAM finds it, is allowed to run it, and
   follows it.

   Open a fresh coding-agent session in a project unrelated to JAM, on a
   machine in the zero state above (say which of the four it establishes), and
   give it exactly three inputs and nothing else:

   ```text
   https://github.com/colosair/asc
   https://github.com/colosair/jam
   적용해
   ```

   It is graded as two gates, because two different things can fail and the
   fixes are not in the same place.

   **Gate A — host invocation.** Everything before JAM starts:

   - the agent chooses the canonical command
   - it runs it with the string unmodified: no `cd`, pipe, redirection, `&&`,
     environment prefix, or substituted package runner
   - the host allows it to execute
   - the JAM process actually starts (JAM output appears)

   Check the same for the self-heal command JAM hands back,
   `runtime use package` — a host can refuse that one too, and an acceptance
   that only exercised the first command has not established Gate A.

   Two grades, because a host's own policy is not JAM's to fix:

   - **A0 — pristine.** No JAM-related permission rule anywhere. Record the
     result; it is a compatibility observation, not a release bar. A refusal
     here is the host's policy, not a JAM defect and not a documentation
     defect.
   - **A1 — documented exact trust.** Exactly the user-local rules this
     repository documents, and nothing broader. **A1 must pass.** If it does
     not, the fallback JAM documents does not work, and that is a release
     blocker — fix the documented contract, do not widen the rule.

   **Gate B — JAM bootstrap.** Once the process is running:

   **PASS:** it reaches `doctor --json` `ready` against a real site and makes a
   real Jira read, having stopped only at human boundaries —
   `JAM_PROJECT_SELECTION_REQUIRED` and `JAM_AUTH_REQUIRED`.

   **FAIL**, and record which:
   - asked whether to replace or coexist with an existing Atlassian MCP
   - asked whether setup needs a Jira issue, branch, or PR
   - installed from a clone (`npm ci`, a build, `npm link`) instead of the
     registry
   - asked about `JAM_RUNTIME_CONFIG_MISSING` instead of running the command it
     carries
   - asked any other question the documented rules already answer

   Every Gate B failure is a documentation failure, not an agent failure: the
   rule is missing, or it is somewhere the agent did not read. Fix it there.
   Gate B must pass.

   Record the run with enough detail that the next host version can be compared
   against it:

   ```text
   Claude Code version
   OS
   Auto Mode enabled
   autoMode.classifyAllShell
   permission scope (user-level / project) and rule shape (exact / wildcard)
   canonical command, verbatim
   classifier PASS / BLOCKED
   JAM process started yes/no
   first observed JAM status code
   doctor result
   actual Jira read PASS / FAIL
   ```

   Redacted as described under [Recorded runs](#recorded-runs): status codes
   and outcomes, never Jira keys, project lists, sites, or accounts.

   `autoMode.classifyAllShell` matters enough to record every time. With it
   set, a host suspends its Bash allow rules and sends every shell command to
   its classifier — so an exact rule stops being a fallback, and A1 has to be
   established through whatever user-level intent that host offers instead. An
   A1 result recorded without that value cannot be compared to the next one.

7. **Tag** the release commit and push the tag — after A1 and Gate B have
   passed against the published packages, never before.
8. **GitHub Release** against that tag.

Publishing stays a human step. CI is automatic; `npm publish` is not. An npm
version cannot be taken back, the release cadence is low, and the manual cost is
small — that trade will be worth revisiting when the cadence changes, together
with provenance and trusted publishing.

## Recorded runs

What a host did, on a stated version, against a stated command. Kept so the
next host release can be compared to the last one rather than re-argued.

The transcripts below are evidence of what happened, not instructions. The
commands in them are quoted verbatim, pinned to the version that was current
at the time and wrapped exactly as the agent wrapped them - which is why the
block is fenced off from `release-check`, whose job is to keep *instructions*
current and unwrapped.

**What a record may not contain.** Never a Jira project or space key or name,
a visible project list, an issue key, a site URL, or anything identifying an
account. An acceptance run is evidence about JAM and about a host, and none of
those belong to either - the same rule the read benchmarks already work under
(`docs/benchmarks/jira-read-v1/methodology.md`). Record the JAM status code,
the shape of the command, what the host did, and whether Jira answered:

```text
doctor: ready
actual Jira read: PASS
```

Not which issue it read, not from which project, not as whom. A run that
cannot be described without naming one of those is a run that should be
described more abstractly, not one that earns an exception.

<!-- release-check: historical-evidence:start -->

### 2026-08-27 — Claude Code auto mode, canonical bootstrap refused

Claude Code 2.1.246 (claude-desktop), macOS, model claude-opus-5, Auto Mode on
(`permissionMode: "auto"`, no bypass), cwd a project unrelated to JAM.
`autoMode.classifyAllShell` unset everywhere.

The agent ran, verbatim:

```text
npx --yes @jam-mcp/bootstrap@1.3.1 setup --agent 2>&1 | tail -60
```

The host refused before execution: *"Permission for this action was denied by
the Claude Code auto mode classifier. Reason: Blocked by classifier."* No JAM
output of any kind. The process never started.

The agent then reached READY through four other commands, each wrapped the same
way (`2>&1 | tail -N`): `setup plan --json`, `setup --project <KEY>
--non-interactive --json`, `runtime use package --json`, `doctor --json`. So
the wrapper alone did not decide it.

A second measurement the next day, Claude Code 2.1.233, macOS 26.5.2, Auto Mode
on, same kind of project, with two JAM rules present in the project's
`.claude/settings.local.json` but **neither matching this command**:

```text
npx --yes @jam-mcp/bootstrap@1.3.1 setup --agent
```

Same refusal, same absence of output. **A0 = blocked, for the unwrapped
canonical command.**

### 2026-08-28 — the documented rule lets the same command through

Same machine and host as above, `autoMode.classifyAllShell` still unset. One
rule added, in the user's own settings (`~/.claude/settings.json`), and nothing
broader:

```text
Bash(npx --yes @jam-mcp/bootstrap@1.3.1 setup --agent)
```

Then the same command, unchanged:

```text
npx --yes @jam-mcp/bootstrap@1.3.1 setup --agent
```

```text
host                        Claude Code, Auto Mode
permission scope            user-level
permission type             exact Bash rule
autoMode.classifyAllShell   unset / default
canonical command           pure, unwrapped
classifier                  PASS
JAM process started         yes
first observed JAM state    JAM_PROJECT_SELECTION_REQUIRED
```

The host allowed it, JAM started, and the first thing it said was a JAM human
boundary - Gate B's business, no longer the host's. **A1 = pass**, measured
against 1.3.1 before 1.3.2 was published, so the contract this release
documents was known to work before it was written down as the fallback. It does
not stand in for the release gate: A1 has to pass again against the published
1.3.2 packages, with the rule pinned to that version, before there is a tag.

Note what the exact rule had to match: the command with nothing around it. The
refused invocation in the entry above carried `2>&1 | tail -60`, and no rule
written for the canonical command would have matched that. Same host, same
day, same package - the difference was the wrapper.

<!-- release-check: historical-evidence:end -->

What that establishes, and what it does not: a pristine auto-mode host can
refuse the canonical bootstrap on its own judgement, with the command in its
simplest possible form. It is therefore not a wrapper defect, and no rewriting
of the command is the fix. What JAM guarantees instead is A1, and the second
entry above is that guarantee measured rather than asserted: the exact, narrow,
user-local rule this repository documents does let the same command through.

The wrapper is still worth forbidding, for a separate and now-documented
reason: a host matches permission rules against the whole command, and a pipe
makes it compound, so a wrapped invocation matches no rule written for the
canonical one. Wrapping removes the fallback even where the fallback would have
worked.

### v1.3.1

Published to npm as 1.3.0's successor, then superseded before release
acceptance completed. **Published but not tagged**, and no GitHub Release. It
was not unpublished - an npm version is immutable and yanking one people may
already have resolved is worse than leaving it. 1.3.2 is the canonical release.

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
