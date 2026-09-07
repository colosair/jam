# JAM release evidence

Past acceptance runs, kept as they were written. This file is **evidence, not
instructions**: the commands quoted here are pinned to the version that was current at
the time and wrapped exactly as the agent wrapped them. `docs/operations/release.md` is
the procedure to follow today.

The split exists because one file cannot be both. A procedure has to move when the product
moves; a record has to stay still, or it stops being a record.

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
