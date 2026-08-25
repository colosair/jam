# ADR: Agent-oriented Jira read optimization

- **Status:** Accepted
- **Supersedes:** nothing
- **Evidence:** [benchmarks/jira-read-v1](../benchmarks/jira-read-v1/README.md)

## Context

Agents read Jira constantly — checking what is open, whether something is
blocked, whether a decision was actually made. Routed through the existing Jira
MCP's default read path, that traffic behaved badly in ways that compounded:

- **Payload far exceeded the question.** A listing query returned every issue's
  `description`, plus `self` URLs, avatar variants, account metadata,
  `statusCategory` objects and `expand` strings. Measured: 93,320 bytes for 17
  issues, of which `description` alone was 11,995 bytes (~12.9%), for a query
  that needed none of it.
- **Results did not fit.** All three measured runs exceeded the client's
  tool-result limit — `result exceeds maximum allowed tokens` — so the data
  never reached the agent's context directly. Each run required recovery work:
  dump to a file, extract with jq, try again.
- **Optimisation depended on the prompt.** The MCP does accept an explicit
  field list. Whether any given call was cheap therefore depended on whether
  the model remembered to ask correctly — which is not a property a team can
  rely on, and not one that holds consistently across people, sessions, or
  model versions.
- **Completeness was invisible.** A page of results and a complete result set
  look identical. An agent could conclude "these are all the open issues" from
  a first page, or "nothing was agreed" from a partial comment thread, with
  nothing in the response contradicting it.

The last point is the one that makes this a correctness problem rather than a
cost problem. Everything above is affordable until a wrong judgement gets made
from a partial read.

## Decision

**Agent-oriented Jira reads are mediated by JAM so that field selection,
pagination, completeness, and output-budget policies are enforced server-side
rather than delegated to each model invocation.**

Concretely:

**Three read tools, fixed as the external contract.** Each corresponds to a
class of judgement, not to an endpoint:

```text
jira_search    listing, discovery, "what is open"
jira_context   readiness, blockers, dependencies, priority
jira_full      agreement, contract, approval, closure
```

Adding or renaming one is a breaking change. Internal implementation — cache,
transport, Rovo, whatever comes later — must not disturb it.

**Four policies enforced in code, not in prompts:**

- *Field whitelist* — each level requests a fixed field set. `description`,
  `comment`, `attachment` and `changelog` are stripped from the lower levels
  even when a project config asks for them. `fields=*` is unreachable by
  construction.
- *Pagination* — JAM owns it. `scope: "complete"` follows `nextPageToken` to
  exhaustion; a page-sized result is never mistakable for the whole set.
- *Completeness* — every result carries `CompletenessMeta`. Anything dropped
  appears there with a reason. Silent truncation is a release blocker.
- *Output budget* — per-level ceilings, with a fixed drop order (history,
  oldest comments, links, description) and the drop always reported.

**Jira stays the source of truth.** JAM is a read-optimisation layer, not a
system of record.

**Each user authenticates as themselves.** JAM shares policy, never
permissions. No shared service account.

## Consequences

### Gained

- Payload down ~95% and estimated tool-result tokens down ~95% on the measured
  workload, with the same 17 issues and nothing a listing judgement needs
  omitted.
- Tool-side latency down 39.4% and wall latency down 33.9% on the same
  workload, consistent across all three repetitions.
- Overflow eliminated on this workload — the result is directly usable rather
  than requiring per-call recovery.
- Consistent agent behaviour: the same policy applies to every teammate, every
  session, regardless of how the request was phrased.
- Partial results are legible. An agent can distinguish "this is everything"
  from "this is some of it", which is what makes a readiness or agreement call
  defensible.

### Given up

- **Another service to maintain.** JAM is code the team now owns, alongside the
  Jira MCP it does not replace.
- **A new failure point.** If JAM is broken or misconfigured, Jira reads stop.
  Mitigated by `jam doctor`, by a boot health gate that refuses to half-start
  the server, and by the existing Atlassian MCP remaining available as a
  fallback.
- **Jira API drift is now our problem.** Endpoint or field changes must be
  absorbed in the adapter.
- **A judgement policy is required.** Constraining reads to what Jira holds
  makes it easier to mistake "Jira has no record" for "no decision was made".
  Addressed by the *absence of evidence* rule in `CLAUDE.md`, `AGENTS.md` and
  the `jira_full` tool description; not solvable by retrieval alone.
- **Less flexibility at the call site.** An agent cannot request an arbitrary
  field for a one-off need. That is the intended trade — it is the same
  property that prevents an accidental `fields=*`.

### Explicitly not concluded

The benchmark cannot isolate Jira REST's own processing time, so this decision
makes no claim about whether Jira's API is a bottleneck. JAM did not make Jira
faster; it removed data the agent did not need and an extra call path around
it.

Nor is the ~95% figure a protocol-level claim. The existing MCP can be tuned
with an explicit field list and would close most of that gap. The comparison
measured safe defaults against defaults. The tuned comparison is
[follow-up A](../architecture/backlog.md#follow-up-benchmark-a--tuned-baseline)
and has not been run.

The decision does not rest on the margin. It rests on where the optimisation
decision lives:

```text
Before:  the call is cheap when the agent asks correctly, every time
After:   the code makes asking incorrectly difficult
```

## Cache: deferred

`CachePort` exists; `NoopCache` is what ships.

JAM's mean tool-side latency is ~2.8 s on the measured workload and the payload
problem is solved. A cache would add staleness, invalidation, permission
boundary and read-after-write consistency concerns in exchange for a latency
gain the current evidence does not justify — and read-after-write in particular
interacts with the consistency rule that a write must be confirmed by a direct
issue GET, never by a search result.

The seam stays so this can be revisited without reshaping the application
layer. Revisit when real usage identifies a bottleneck these measurements did
not.

## Related

- [Benchmark evidence](../benchmarks/jira-read-v1/README.md) — measurements,
  derivations, fairness caveats
- [Architecture backlog](../architecture/backlog.md) — `dependencyConsistency`
  candidate, tuned-baseline and whole-workflow follow-ups
- [Design of record](../architecture/jira-agent-mcp-design.md)
