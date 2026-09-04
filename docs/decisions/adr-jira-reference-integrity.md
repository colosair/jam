# ADR: Jira reference integrity

**Status:** accepted
**Relates to:** [ADR: the Jira write plane](adr-jira-write-plane.md), whose plan/apply
shape this pins to an identity rather than to a key.

## Context

An agent working with Jira needed a key for work that had no issue yet. It took
the next number in the project — the last issue was *N*, so the work became
*N+1* — and wrote that string into a branch name, into every commit on the
branch, and into the merge request.

The number was not an issue. Days later Jira minted it for somebody else's
work, and the Git/Jira integration did what it is built to do: it found the key
in the existing commits and merge request and attached them, retroactively, to
an issue nobody had meant. Nothing errored. The key was well-formed, the
integration was working correctly, and the record was wrong.

What made this possible is not a Git problem, and no Git policy fixes it. It is
an assumption an agent can make anywhere: **that a key which does not resolve is
a key that is free.** Jira does not offer that guarantee and never has. A number
nobody holds today is minted tomorrow.

JAM sits between agents and Jira, and it had two properties that let the
assumption through:

- **JAM taught nothing about keys.** Its agent-facing documents covered read
  levels, completeness and the write plane, and said nothing about where a key
  comes from. Silence reads as "use your judgement", and the judgement here is
  wrong.
- **JAM was already receiving the answer and throwing it away.** Every Jira
  issue payload carries `id`, the immutable identity, alongside `key`. The
  adapter's raw type declared it. The mapper dropped it. So even an agent that
  wanted to hold a stable reference had only the string that can move.

## Decision

### 1. A Jira issue key is never predicted

Pinned in `AGENTS.md` and `CLAUDE.md`, which are what a host actually loads:

> Never synthesize, increment, predict, reserve, or infer the availability of a
> Jira issue key.

Not the next number, not a gap in a sequence, not a number that looks
unclaimed. The rule is stated as a universal, because the failure is universal:
it does not depend on which SCM, which integration, or which project.

### 2. `key` is the locator; `issueId` is the identity

```text
key     = the current human- and integration-facing reference to an issue
issueId = the issue
```

Jira mints both. A key is scoped to a project and can be moved to another
issue; the id cannot. Every issue JAM returns now carries `issueId` beside
`key`, at all three read levels and on nested references — parent, subtasks and
both sides of an issue link — wherever Jira supplies one.

### 3. Positive resolution is what makes a key safe to reuse

Before a key is written anywhere durable, it is resolved against live Jira by
exact key, through the tool that already does that: `jira_context`.

```text
requested exact key -> Jira returns that issue, with its canonical id
                    =  positive resolution

requested exact key -> meta.missingKeys
                    =  unusable; nothing else is known
```

No new tool, and no new field. The exact-key path and `meta.missingKeys` were
already the contract; what was missing was the statement of what they mean.

### 4. Missing, unreadable or inaccessible is not "unused"

A key in `meta.missingKeys` resolved to nothing this account can see. The issue
may not exist; it may exist and be invisible to these credentials. **From here
those are the same answer**, and neither of them is "the number is free". JAM
says so in the tool description, in the agent documents, and in the note on the
result.

This is the sentence the incident turned on, so it is the one under a
regression gate (below).

### 5. A key for new work comes from Jira, by creating the issue

`issue.create` takes no key, and gains none. There is no `predictedKey`,
`nextKey`, `reservedKey` or `suggestedKey`, and adding one would be adding the
defect as a feature. Jira mints the key when the issue is created, and the
apply receipt reports what Jira returned — plus, now, `issueId`.

### 6. Status semantics come from Jira, not from string matching

An agent deciding whether an issue is finished was left matching `status`
against words. `status` is a workflow-defined, localized name: a
category-`done` status can read "Shipped", "완료" or "Won't Fix", and any list
of words is wrong in some project or some language.

So `statusCategory` — Jira's own machine-readable category key — travels beside
`status`. JAM passes Jira's value through unchanged. It does not rename the
values, does not derive one from a status name, and does not turn it into a
readiness verdict of JAM's own. A status with no category has no
`statusCategory`; absent is absent, not `new`.

### 7. Identity costs nothing

The constraint on this whole change:

```text
issueId propagation          +0 Jira requests
statusCategory propagation   +0 Jira requests
exact-key resolution         the lookup that was already happening
write identity checks        the reads a write already makes
```

`id` and `key` are properties of the issue resource, not fields, so they arrive
whatever the field list says. `statusCategory` arrives inside the `status`
field that was always requested. Nested references carry `id` in the payload
Jira already sent. **No nested reference is ever fetched to fill in an id** —
that would trade a correctness fix for an N+1, which is the trade this codebase
exists to refuse. Where Jira does not supply an id, the field is absent; it is
never an empty string, which would read as an identity that was checked and
found blank.

The one place identity is required rather than reported is the write plane's
direct read, which is the read every write already goes through. A positive
issue result with no canonical id is refused there (`PARTIAL_RESULT`) rather
than carried into a plan. A read of many issues is not failed because one entry
came back thin.

### 8. The write plane is pinned to the issue, not to the string

A plan records `issueId`. Apply re-reads the issue and asks the identity
question before the revision question: if the key now names a different issue,
its `updated` timestamp is a fact about something nobody planned to change. The
post-write verification read asks again, because confirming the intended value
on an issue the key has since come to name would be reporting somebody else's
state as proof of our write.

Both refusals are `JAM_WRITE_CONFLICT`. No new error code: the situation is one
an agent already knows how to handle — the ground moved, plan again against the
current state — and a second code would only fragment that.

### 9. Git and SCM orchestration stay outside JAM

JAM does not create branches, does not read commits, does not know GitHub from
GitLab, and gains none of that here. The incident happened in Git, and the fix
is still not a Git feature: what JAM owns is the Jira truth an agent reasons
from, and the defect was that JAM's answer about a key was ambiguous. Branch
guards, commit interception and PR lifecycle belong to a control plane above
JAM (ASC is one), which is free to build them on the identity JAM now returns.

### 10. Standalone JAM is complete without any of that

Nothing here depends on a control plane being present. An agent with only JAM
installed gets the rule in the documents its host loads, `issueId` on every
read, `statusCategory` on every status, an unambiguous answer for a key that
did not resolve, and a write plane that refuses to act on a key that changed
identity. That is the whole of what JAM can honestly guarantee, and it is
guaranteed with JAM alone.

### 11. Compatibility: additive only

The MCP surface is unchanged — five tools, same names, same input schemas.
Everything added is output: `issueId` and `statusCategory` on read results and
nested references, `issueId` on the plan and apply receipts. A consumer that
never reads the new fields sees the contract it saw before.

### 12. Deferred

- **`issue.create(parent)`** — creating a subtask needs a parent reference on
  the create contract. That is a write-capability change with its own schema
  and verification questions, and mixing it into an identity release would blur
  both.
- **Caching or coalescing identical reads.** No measurement showed duplicate
  in-flight reads worth a subsystem, and the correct amount of speculative
  cache is none.
- **Anything that resolves a key JAM has not been asked about.** JAM answers
  about keys it is given; it does not go looking, and it does not enumerate a
  project to decide what is unused.

## Consequences

**The rule is now regression-tested, not remembered.** `release:check` fails if
`AGENTS.md` and `CLAUDE.md` stop stating that a key is never predicted, that an
exact key must positively resolve against live Jira, and that a missing key is
not evidence the number is free — matched on collapsed whitespace so rewrapping
a paragraph is not a failure, and mirrored word-for-word between the two files.
A future edit that quietly drops the rule fails the release gate.

**Identity is available to consumers that want it, and invisible to those that
do not.** A control plane can record `issueId` alongside a key and detect the
day a key stops naming the same issue. An agent that only ever prints keys is
unaffected.

**What this does not do.** It does not stop anyone from typing an invented key
into a branch name — JAM is not in that path and says so. It removes the
premise the mistake rested on, states the correct procedure where an agent will
read it, and makes the safe answer the one that is already in hand.
