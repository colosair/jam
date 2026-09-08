# ADR: the Jira write plane

**Status:** accepted, v1.1.0
**Supersedes:** the read-only stance recorded in [ADR: Jira read optimization](adr-jam-jira-read-optimization.md), which left the write boundary deliberately empty.

## Context

JAM shipped read-only on purpose. The ports, the consistency rule and the
adapter split were all built with writing in mind, and then writing was left
out — the first release had nothing to prove about it, and a half-considered
write path would have been harder to remove than to never add.

That boundary is now being filled. The question this decides is not "can JAM
call Jira's REST write endpoints" — that part is small — but what shape the
write surface takes so that an agent using it cannot do damage it did not
intend and the user did not see.

## Decision

**Writing is two calls, not one.** `jira_write_plan` reads the issue, works out
whether the change is possible, and returns a description of what would happen.
`jira_write_apply` takes a `planId` and nothing else.

The split is the whole design. An agent cannot hand JAM a mutation, because
there is no parameter to hand it through: the only thing apply accepts is a
handle to a plan JAM itself produced, from a read JAM itself did. "Change the
status to Done" becomes "here is the transition Jira currently offers, from
this status, resolved to this id" before anything is sent.

**A plan is a snapshot, and snapshots go stale.** Every plan records the
issue's `updated` timestamp. Apply re-reads the issue and refuses when it has
moved (`JAM_WRITE_CONFLICT`), because a plan that was valid is not the same as
a plan that is still valid. The remedy is to plan again, not to force the old
one through.

**A write is confirmed by reading, never by the write's own response.** Jira
accepting a request is not evidence that the issue changed: a transition can be
accepted and land elsewhere under a workflow rule, a field update can be
dropped by a screen configuration. So apply reads the issue back and checks the
intended result is actually there. Anything else is
`JAM_WRITE_VERIFICATION_FAILED`, and never an `applied` receipt. This is the
ConsistencyPolicy rule the first release wrote down and had nothing to enforce
it against.

**Ambiguity is resolved by looking, not by trying again.** The read path
retries transient failures; the write path must not. A POST that times out may
already have been applied, and resending it turns one comment into two. An
ambiguous failure becomes `JAM_WRITE_UNCERTAIN`, which tells the caller to read
the issue and explicitly not to retry.

**Writes stay inside the configured project.** The workspace binding is what
the user consented to during setup. A key from anywhere else is refused by JAM
(`JAM_WRITE_SCOPE_VIOLATION`) before a request is made, rather than left to
come back as an unexplained 403.

**The public surface is a closed set.** Four operations — `comment.add`,
`field.update`, `status.transition`, `issue.create` — a four-field whitelist for
updates, and a six-field one for creation. Comments and descriptions are
accepted as plain text and converted to ADF here; an agent cannot supply a
document tree.

**Creation checks the schema instead of a revision.** The other three
operations detect a conflict by comparing the issue's `updated` timestamp
between plan and apply. Creation has no issue and no revision, so its
concurrency boundary is the project's create schema: a plan records the
premises it was built on — the issue type, the required fields, the values
resolved from Jira's allowed lists — and apply re-derives whether each still
holds (`JAM_WRITE_SCHEMA_CHANGED`). Deliberately not a hash of the metadata
document: an unrelated optional field appearing on a create screen invalidates
nothing, and treating it as though it did would make every plan on an active
project fail.

**A name is not an identity.** `assignee.update` takes what a person would
say - a display name, or an accountId - and never sends it. Jira's user search
is a substring match, so its answers are candidates: JAM assigns only when
exactly one candidate matches exactly (an accountId, or a display name ignoring
case), and refuses with the candidates attached otherwise
(`JAM_WRITE_ASSIGNEE_NOT_FOUND`, `JAM_WRITE_ASSIGNEE_AMBIGUOUS`). One
substring hit is Jira reporting a similarity, not identifying who was meant,
and choosing it would cost somebody an issue assigned to the wrong colleague.

An accountId is resolved by an identity lookup rather than by a search that
happens to match it. Jira's user search does currently return a user when the
query is their accountId - but that is a property of a substring search, not a
promise, and a contract that says "or an accountId" cannot rest on a
coincidence. The search runs first because it usually settles both halves; when
it settles nothing, `GET /rest/api/3/user?accountId=` is asked before giving
up. The string is never inspected to guess whether it looks like an id.

Assignability is asked, not modelled: JAM does not carry a copy of Jira's
permission scheme, so it asks whether this account may hold this issue - at
plan time, and again immediately before the write, because a permission that
held is not a permission that still holds. Verification compares the
`accountId`; a display-name comparison would accept the wrong person's
assignment as proof of the right one's, which is the failure the whole
resolution step exists to prevent.

**Confirmation is a single-issue GET.** ConsistencyPolicy's "direct issue read"
is `JiraReadPort.getIssue` - `GET /rest/api/3/issue/{key}` - not the bulk
`getIssues` the read tools use. A bulk endpoint takes a list and is free to
answer from a different path than the single-issue one; that is invisible in a
listing and decisive in the read that decides whether a mutation may proceed or
whether one landed. The write plane uses it for all three of its reads.

**A receipt's promise is the check.** A create plan's `verification.expects`
names what a direct read will have to show, and every field it names is
compared - a field the receipt promises and the check skips reports
`verified: true` about something nobody looked at. That includes the
description, which needs canonical comparison rather than a raw one: the text
becomes a document, Jira stores the document, and reading it back renders text
again, so blank-line runs collapse and block edges lose whitespace. Both sides
are normalized by the same function that builds the document
(`canonicalizePlainText`), so formatting cannot fail a verification and
different text cannot pass one. The project the issue landed in is checked too
- the workspace binding is the whole of JAM's write scope.

**A create is never retried.** This is the sharpest case of the rule the whole
write plane follows. A repeated update converges; a repeated create leaves a
second issue with a key nobody is holding. An ambiguous failure — a 5xx, a
dropped connection, or a create Jira accepted without naming — is reported as
`JAM_WRITE_UNCERTAIN` and resolved by looking in the project.

## Where plans live

**In a file under `~/.jam/write-plans/`, for ten minutes, shared by both
transports.**

This was in memory, in the server process, and the reason it moved is the
condition this section named for revisiting: plans had to outlive a process.

`jam jira write-plan` and `jam jira write-apply` are two invocations. An
in-memory plan is gone before apply can see it, so writing from the shell was
impossible — and writing from the shell is what a session needs when its MCP
registry came up in a failed state and the tools cannot be re-registered
without restarting it. Sharing one store between MCP and the CLI also means a
plan made through the tools can be applied from the shell after they stop
answering, which is the case the whole change exists for.

A signed token was still not the shape. The signing key has the same problem it
had before: a key on disk is new secret material to protect, and a per-process
key gives a token the lifetime an in-memory map already had. JAM does hold an
OS secret store, but its contract is the Jira credential triple, and widening
it to carry a signing key is a larger change than the one being made.

**What replaces the in-process guarantee is re-derivation, not a signature.**
Apply reads the plan's own recorded input, derives the mutation from it again,
and refuses (`JAM_WRITE_PLAN_TAMPERED`) if the stored mutation is not what that
input produces. Editing the file to smuggle a different write means editing the
input to match — which is asking JAM to plan that write, which is what
`jira_write_plan` is. There is nothing to gain by forging a plan that could be
obtained by requesting one.

Re-derivation reads the plan's recorded resolutions rather than asking Jira
again. Planning called Jira for a transition list and a user directory and
wrote down what it settled on; re-running those would cost a round trip and
would re-raise refusals that belong to planning ("already assigned", "not
assignable"), reporting a fact about the current state as though the plan were
malformed. What is checked is narrower and sufficient: the mutation must be the
one this plan's own parts describe.

Single use is now enforced by the filesystem. `take` claims a plan by renaming
it, so two concurrent applies cannot both hold one — for `comment.add` the
alternative is two comments.

The cost is that a mutation is now serialized where the machine's user can read
and edit it. That is a real reduction from "forgery is impossible" to "forgery
gains nothing", and it is the price of a write path that survives its
transport. Plans are still short-lived, still single-use, and still only valid
while the issue has not moved.

## Consequences

The external contract grows from three tools to five. The read three are
untouched — same names, same inputs, same `meta` semantics — because a write
release that quietly changed read behaviour would be the worst kind of
surprise.

Read `meta` is deliberately not reused for writes. `meta.complete` answers "how
complete was this retrieval"; a write receipt answers "did this happen, and did
we see it happen". Sharing the vocabulary would let a confident `complete: true`
stand in for a verified mutation.

Two round trips per write becomes three: plan reads, apply re-reads, apply
verifies. That is the price of the guarantees, and it is paid on writes only —
which are rare compared to reads, and are the calls where being wrong is
expensive.

Some things an agent might reasonably want are not here: creating and deleting
issues, bulk operations, editing comments, worklogs, attachments, links,
assignee, custom fields. Each needs its own decisions — schema discovery for
create, accountId resolution for assignee, a much harder confirmation story for
bulk — and none of them are made easier by being rushed into this release.

## Related

- [JAM design of record](../architecture/jira-agent-mcp-design.md)
- [ADR: Jira read optimization](adr-jam-jira-read-optimization.md)
