# Architecture backlog

Deferred work with a recorded reason. Nothing here is committed to a release;
each item exists so a decision that was made deliberately does not get
re-litigated from scratch, or quietly forgotten.

All examples are anonymised. `PROJECT-101` style keys are placeholders.

---

## 1. `dependencyConsistency` — structured links vs. prose dependencies

**Status:** candidate, not implemented.

### Observation

Real-world `jira_full` reads surfaced a recurring mismatch:

```text
description:  names several prerequisite / blocking issues in prose
issueLinks:   only some of those issues are actually linked
```

This is not a JAM retrieval bug. JAM returned everything Jira held, and
`meta.linksComplete` was true. It is a Jira **data quality** mismatch: the
person writing the description named dependencies that nobody then recorded as
links.

What it would detect is a **disagreement inside Jira's own record** — prose and
structure describing different dependency sets. It is not repository dependency
detection, and it would not tell anyone whether work can start: JAM reports Jira
evidence, and `meta.limitations` already says the repository and external
sources were not evaluated.

It matters because `jira_context` supplies the Jira-recorded evidence for a
readiness question, and `issueLinks` is the structured half of it. If a
prerequisite was only ever written in prose, a reader who sees an empty link
list is missing something Jira itself contains — which is a narrower and more
answerable problem than "is this really blocked".

### Candidate behaviour

```text
issue key mentioned in description
        +
no matching entry in issueLinks
        ↓
dependencyConsistency = warning
```

Surfaced in the result metadata alongside the existing completeness fields, so
the agent can say "the links say unblocked, but the description names
PROJECT-101 which is not linked — worth checking" instead of silently trusting
one of the two.

### Design constraints, if this is ever built

- **Neither side is canonical.** The description is not the source of truth and
  neither is `issueLinks`. The output must report the *disagreement*, not
  resolve it. Picking a winner would be inventing a dependency graph Jira does
  not have.
- JAM must not auto-create, auto-follow, or auto-fetch the mentioned issues.
  Detection only.
- A key mentioned in passing ("supersedes the approach from PROJECT-101") is
  not necessarily a dependency. Expect false positives; the warning has to be
  cheap to ignore, which argues for metadata rather than anything that changes
  the shape of the result.
- Cost: naive key-regex over descriptions is nearly free. Anything smarter is
  not, and would need its own justification.

### Why not now

The first release's job was to get Search/Context/Full correct and cheap. This
adds a heuristic with a real false-positive rate to a layer whose current value
is that it never guesses. It needs its own evidence — how often the mismatch
occurs, and how often it actually changes a readiness call — before it earns a
place in `ConsistencyPolicy`.

---

## 2. Follow-up benchmark A — tuned baseline

**Status:** planned, not run.

The completed [jira-read-v1 benchmark](../benchmarks/jira-read-v1/README.md)
compares the stock Jira MCP's **default** field set against JAM's safe
defaults. That is the honest comparison for "what a team gets out of the box",
but it is not the comparison for "what does JAM's structure buy you".

Method: re-run the identical workload against the existing Jira MCP with the
same fields JAM requests, explicitly specified by the caller:

```text
summary
status
assignee
priority
updated
labels
components
```

Three repetitions, same measurement protocol as v1.

Purpose:

> Measure JAM's structural advantage against a well-tuned baseline, rather than
> against a difference in default settings.

This is the fair-comparison counterpart to the fairness caveat already recorded
in the v1 results, and its numbers will be lower. That is expected and is the
point of running it.

---

## 3. Follow-up benchmark B — whole-workflow comparison

**Status:** planned, not run.

v1 measured a single list query. Real agent work is an escalation:

```text
JAM:       jira_search  →  jira_context  →  jira_full
Baseline:  search       →  issue detail  →  comments / links
```

Measure total cost — round trips, payload, tokens, wall time, and whether any
step overflows — across the full sequence for one representative judgement
task.

Purpose:

> Compare the cost of reaching an actual work decision, not the cost of one
> listing call.

---

---

## 4. `statusChangedAt` — freshness beyond `updated`

**Status:** deferred, with a stated cost.

`jira_full` now reports `latestCommentAt`, and every level already carries
`issue.updated` and `meta.fetchedAt`. The missing freshness fact is when the
status last changed — "In Progress since when", which is the one an ageing
board actually turns on.

It cannot be derived from what JAM fetches. Status transitions live in the
changelog, which is in `HEAVY_FIELDS` and never requested; `expand=changelog`
appears nowhere. Adding it means a heavier read on every full call, against a
policy whose whole value is that a read stays cheap and predictable.

So it waits for evidence that it changes decisions often enough to be worth
that, and JAM ships the facts it already holds rather than a proxy dressed up
as the real thing. `issue.updated` is not that fact: it moves for any edit.

Nothing here becomes a `stale` flag. Thresholds are per-team, and a verdict
computed from someone else's threshold is worse than a timestamp.

---

### Rule for the benchmark follow-ups

None of these results may be merged into, or presented as revisions of, the
v1 benchmark. v1 measured what it measured under a stated protocol; a
follow-up with a different protocol is a separate record with its own
directory and its own methodology file.
