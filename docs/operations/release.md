# Releasing JAM

The procedure v1.0.1 and v1.1.0 actually used, written down so the next release
is the same one rather than a reconstruction.

## The one invariant

**A tag is created only after acceptance passes against the published packages.**

A tag is a claim that the published artefacts work. Making it before the
published artefacts have been exercised inverts that: it says "this is the
release" about something nobody has run from the registry yet. npm versions are
immutable, so the order is the only thing that keeps a tag honest.

The pipeline now encodes this order instead of asking anyone to remember it:
publishing (`release.yml`) and finalization (`release-finalize.yml`) are two
separate dispatches, and only the second one - run after acceptance - creates
the tag and the GitHub Release.

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

> **The canonical release path is remote, in two stages.**
>
> **Stage 1 — publish.** Dispatch `.github/workflows/release.yml` with the
> version (it must equal the manifests on main HEAD). It runs the full gate,
> publishes all three packages via npm Trusted Publishing (OIDC — no local
> login, no long-lived token, no OTP), verifies the registry with
> propagation-tolerant direct HTTP checks, and runs a published smoke. It
> creates **no tag and no Release**.
>
> **Acceptance** (steps 2, 5, 6 below) then runs against the published
> packages — human work, recorded in this file's format.
>
> **Stage 2 — finalize.** Dispatch `.github/workflows/release-finalize.yml`
> with the same version. It verifies the registry already serves the version
> and that `docs/releases/v<version>.md` exists with the mandatory sections,
> then creates the **annotated tag** `JAM v<version>` and the GitHub Release
> from that note. Both workflows take `dry_run`.
>
> The manual steps below (publish, registry confirmation, tag/Release
> creation) are the **emergency fallback** for when GitHub Actions or OIDC is
> down; the acceptance steps remain human work either way. Prerequisite, once
> per package on npmjs.com: connect `colosair/jam` + `release.yml` as the
> trusted publisher — which is why that filename must not change.

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
     repository documents, and nothing broader. A1 is a *fallback* gate: it
     answers whether the documented rule clears a refusal, so it is only
     observable when there was a refusal to clear. **Run it when A0 was
     blocked, and then it must pass.** If A0 passed, the host allowed the
     command on its own and the rule's effect cannot be separated from that -
     record A1 as *not exercised*, never as passed.

     When A1 does run, all of this holds or the run does not count:

     ```text
     A0 blocked first
     exact user-level rule present, nothing broader
     autoMode.classifyAllShell recorded
     command bare: no pipe, redirect, chaining, env prefix, wrapper
     classifier PASS
     JAM process started
     ```

     The command has to be the one the rule names. A host matches the rule
     against the whole command line, so a wrapped invocation cannot match an
     exact rule - and a wrapped invocation that was allowed proves something
     about the host's own judgement, not about the rule. **A wrapped command is
     not A1 evidence.**

     If A1 runs and fails: do not widen the rule, do not rewrite the command,
     do not tag. Fix the documented contract.

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

7. **Finalize** — dispatch `release-finalize.yml` (or, in the fallback, tag by
   hand) only after acceptance against the published packages, never before.
   Acceptance closes in one of three ways:

   ```text
   A0 pass     + Gate B pass                 release (A1 not exercised)
   A0 blocked  + A1 pass    + Gate B pass    release
   A0 blocked  + A1 fail                     blocked - fix the contract
   ```

   Gate B always has to pass. A measurement that was not taken is recorded as
   not taken; it is never written up as a pass.

   Tag annotated, never lightweight, with `JAM v<version>` as the first line
   and a short paragraph saying what the release is for. An annotated tag
   carries its own message and its own author; a lightweight one is a name
   pointing at a commit, and the release it stands for has to be reconstructed
   from elsewhere. Both kinds are in this repository's history, which is the
   argument for the finalize workflow now creating the tag itself — the rule
   stopped being a memory item. Existing lightweight tags stay as they are;
   history is not rewritten.
8. **GitHub Release** against that tag, titled `JAM v<version>` — the title is
   the same for every release, and what the release is about belongs in the
   notes rather than in it. The body is the checked-in
   `docs/releases/v<version>.md`, authored in English with the mandatory
   sections (What changed / Install / Upgrade / Agent setup / Compatibility /
   Verified / Known limitations); `--generate-notes` output is at most a
   supplementary changelog, never the body. `release:check` and the finalize
   workflow both refuse a release without the note.

   Open with a paragraph or two, unheaded, saying what an agent or a person can
   now do that they could not before, and what did not change. Then the
   sections that explain it. Then, always and last:

   - **`## Upgrading`** — which launcher pin to change and where, and what
     stays put. The wording barely varies between releases, and it should not:
     it is the same instruction each time.
   - **`## Verified`** — the test count from Windows, release consistency, the
     smoke check count, CI, and the acceptance this release actually got.
     Written under the same redaction rule as everything else here.

   A release that adds no feature still has both sections. "Nothing to upgrade
   beyond the pin" and "here is what was verified" are answers a reader came
   for.

## How a change gets to main

The gates above check what is in the tree. These are about how it gets there,
and they are written down for the same reason the ones above are: this
repository has drifted on each of them at least once.

- **Squash merge, and the commit subject is the PR title** - without a `(#N)`
  suffix. `gh pr merge --squash` appends one by default; pass the subject
  explicitly, or fix it, so `git log` reads the same as the changelog a person
  would write. Both forms are in the history.
- **A lockstep version bump is its own `chore(release)` PR.** Bundling it into
  the feature PR means the bump and the feature cannot be reverted apart, and
  the release commit stops being identifiable in the log.
- **The branch prefix matches the commit type.** A `docs(...)` change on a
  `fix/...` branch is a small lie in two places at once.

Publishing is automated (npm Trusted Publishing, OIDC) but never spontaneous:
both stages run only on a maintainer's explicit dispatch, and an npm version
cannot be taken back — which is exactly why the publish stage refuses a version
that already exists on the registry, and why acceptance sits between publish
and tag rather than after both.

### Propagation, and the two paths it travels

The registry serving a packument is not the same as npm being able to install
it. They are different paths with different caches, and the gap is real: on
the v1.4.4 run the registry verification passed and the published smoke's
`npm install` then died with `ETARGET` on `@jam-mcp/server`, which had been
published seconds earlier and was visible over HTTP.

So the publish stage waits on both, and neither wait is unbounded:

- **served** — the packument endpoint answers for all three packages, with
  caching off (up to 15 minutes)
- **resolvable** — `npm view --prefer-online` answers for all three, which is
  the resolver the install will use (up to 5 minutes)
- **installable** — the smoke's install itself retries up to six times over
  about five minutes before calling it a failure

A version that misses all three is a genuine problem, not a slow one. A
publish that has already succeeded is never re-published to get past this:
the packages are on the registry and immutable, so verify by hand and carry
on to acceptance (see Failure recovery in docs/release/README.md's asc twin,
and the same rule applies here).

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

### 2026-08-28 — an A1 that was not an A1

Recorded first as a pass, and corrected here from the session transcripts. The
correction is the useful part, so the entry stays.

One rule was added, in the user's own settings, and nothing broader:

```text
Bash(npx --yes @jam-mcp/bootstrap@1.3.1 setup --agent)
```

The command that then ran was not that command:

```text
npx --yes @jam-mcp/bootstrap@1.3.1 setup --agent 2>&1 | tail -60
```

It was allowed, JAM started, and the first state was
`JAM_PROJECT_SELECTION_REQUIRED`. But a host matches a rule against the whole
command line, and the rule names no redirection or pipe - so this invocation
could not have matched it. **The run does not establish that the documented
rule clears a refusal.** What allowed it is not something this measurement can
say.

```text
A1 pre-probe   NOT ESTABLISHED
reason         executed command was wrapped; it cannot match the exact rule
```

Two things this cost, both now fixed. The gate above became conditional,
because A1 was being run in conditions where it could not be observed. And the
purity rule stopped being advice: a wrapper does not merely risk a refusal, it
puts the invocation outside the one rule written to permit it.

### 2026-08-27 — 1.3.2, published

Claude Code 2.1.247, macOS, Auto Mode on, `autoMode.classifyAllShell` unset.
Three invocations of `setup --agent` against the published 1.3.2 packages, and
every one of them carried `2>&1` - the agent added it each time, unprompted.

```text
A0 published    NOT MEASURED for the canonical command
                a wrapped variant was allowed on a pristine host
A1 published    NOT EXERCISED
                nothing was refused, so nothing needed clearing
Gate B          PASS
                setup: ready · doctor: ready · actual Jira read: PASS
                MCP contract: 5 tools · repository footprint: none
```

Gate B stands on its own: `doctor --json` reported `ready` with every check
passing, including the two that are real Jira round trips.

Worth keeping next to the 1.3.1 entry: that host refused the bare canonical
command at 1.3.1 and allowed a wrapped one at 1.3.2, a few hours and a host
version apart. A host's judgement is not a fixed property to design against -
which is why A0 is an observation and not a bar, and why the fallback exists
whether or not any given day needs it.

<!-- release-check: historical-evidence:end -->

What that establishes, and what it does not: a pristine auto-mode host can
refuse the canonical bootstrap on its own judgement, with the command in its
simplest possible form. It is therefore not a wrapper defect, and no rewriting
of the command is the fix. What JAM offers in that case is A1 - and as the
entries above record, A1 has not yet been observed under conditions where it
could be: every attempt either ran a wrapped command the rule could not match,
or ran on a host that was not refusing anything. The fallback is documented and
unmeasured, and this file says so rather than rounding it up.

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
