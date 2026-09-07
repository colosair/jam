# Releasing JAM

> This file is the **current procedure**: what someone running a release today has to do.
> Past acceptance transcripts are in [release-evidence.md](release-evidence.md).


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
2. **Platform acceptance where it is warranted.** `jam status` against live Jira,
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

Past acceptance runs — what a host did, on a stated version, against a stated command —
live in [release-evidence.md](release-evidence.md). They are kept so the next host release
can be compared with the last one rather than re-argued, and they are not edited when the
product moves: a transcript quoting an older command is a record of what was run, not an
instruction for today.

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
