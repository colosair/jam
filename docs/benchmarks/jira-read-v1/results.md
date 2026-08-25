# Results — jira-read-v1

Same JQL, same project, same 17 issues, same session. Three runs each. See
[methodology.md](methodology.md) for how each figure was collected and what it
does not establish.

## Raw measurements

### JAM (`jira_search`, preview scope)

| run | tool-side | wall |
|---:|---:|---:|
| 1 | 2,652 ms | 4,537 ms |
| 2 | 2,809 ms | 4,833 ms |
| 3 | 2,856 ms | 5,672 ms |

| | |
|---|---|
| issues | 17 |
| payload | 4,621 bytes |
| characters | 4,083 |
| tool-result tokens | ~1,335 *(estimate)* |
| pages fetched | 1 |
| Jira operations per call | 1 |
| `meta.complete` | `true` |
| entered agent context directly | 3/3 |

Fields retained: `key`, `summary`, `status`, `updated`, `labels`,
`components`, `assignee`, `priority`.

### Baseline Jira MCP (default field set)

| run | tool-side | wall |
|---:|---:|---:|
| 1 | 3,872 ms | 7,818 ms |
| 2 | 5,045 ms | 7,422 ms |
| 3 | 4,816 ms | 7,507 ms |

| | |
|---|---|
| issues | 17 |
| payload | 93,320 bytes |
| characters | 87,252 |
| tool-result tokens | ~25,335 *(estimate)* |
| pages fetched | 1 |
| remote operations per call | 2+ (resource/cloud lookup, then the query) |
| entered agent context directly | 0/3 — overflowed all three times |

## Derivations

Every reported percentage, worked out in full.

### Tool-side latency

```text
JAM mean       = (2652 + 2809 + 2856) / 3 = 2772.33 ms
Baseline mean  = (3872 + 5045 + 4816) / 3 = 4577.67 ms

Reduction      = 1 - (2772.33 / 4577.67)
               = 0.3943
```

Reported as **39.4% reduction** (2,772 ms vs 4,578 ms).

### Wall latency

```text
JAM mean       = (4537 + 4833 + 5672) / 3 = 5014.00 ms
Baseline mean  = (7818 + 7422 + 7507) / 3 = 7582.33 ms

Reduction      = 1 - (5014.00 / 7582.33)
               = 0.3387
```

Reported as **33.9% reduction** (5,014 ms vs 7,582 ms).

### Payload

```text
Reduction      = 1 - (4621 / 93320) = 0.9505
Ratio          = 93320 / 4621       = 20.19
```

Reported as **95.0% reduction, roughly 20.2×**.

### Tool-result tokens *(estimates)*

```text
Reduction      = 1 - (1335 / 25335) = 0.9473
Ratio          = 25335 / 1335       = 18.98
```

Reported as **~94.7% reduction, roughly 19×**. Both inputs are estimates
derived from payload size, so this row tracks the payload measurement rather
than standing as independent evidence.

## Comparison

| Metric | JAM | Baseline Jira MCP | Change |
|---|---:|---:|---:|
| Tool latency (mean) | 2,772 ms | 4,578 ms | 39.4% lower |
| Wall latency (mean) | 5,014 ms | 7,582 ms | 33.9% lower |
| Payload | 4,621 B | 93,320 B | 95.0% smaller / ~20.2× |
| Tool-result tokens *(est.)* | ~1,335 | ~25,335 | ~94.7% fewer / ~19× |
| Remote operations per call | 1 | 2+ | at least 50% fewer |
| Entered agent context directly | yes | 0/3 | JAM only |
| Listing information missing | 0 | 0 | equivalent |
| Unrequested metadata | none | substantial | JAM smaller |

The last two rows belong together: the payload reduction did not come from
returning less of the answer. Both paths returned the same 17 issues with
everything a listing judgement needs.

## Consistency across runs

All three JAM runs were faster than all three baseline runs, on both measures.

```text
JAM worst wall       5,672 ms
Baseline best wall   7,422 ms
```

The wall-latency ranges did not overlap in this set of measurements. JAM's
tool-side spread was also the narrower of the two.

Three runs per approach is enough to show a consistent direction and not enough
to characterise a distribution. No standard deviation or significance claim is
made here — the honest statement is that all three repetitions pointed the same
way, and the two wall-latency ranges did not overlap.

## What the extra payload consisted of

The baseline returned these fields repeatedly across the 17 issues, none of
which a listing judgement uses:

`self`, `avatarUrls`, `iconUrl`, avatar size variants, `accountId`,
`timeZone`, `accountType`, `active`, `statusCategory`, `expand`, `avatarId`,
`hierarchyLevel`, `subtask`

It also returned `description` for every issue, despite the query being a
listing query:

```text
description total   11,995 bytes
                    11995 / 93320 = 12.9% of payload
```

Reducing the same 17 issues to the fields JAM returns gives roughly 4.4 KB —
close to JAM's measured 4,621 bytes. The large majority of the original payload
was not related to the judgement being made.

## Overflow

The baseline result exceeded the client's tool-result limit on all three runs:

```text
result exceeds maximum allowed tokens
```

The data never reached the agent's context directly. Each run needed recovery
work — writing the result to a file, extracting fields with jq or equivalent —
before it could be used. That recovery cost is real and is *not* included in
any latency figure above; the measured times are for the calls alone.

JAM's result was directly usable on all three runs.

## On where the cost came from

This benchmark cannot isolate Jira REST's own processing time, so it does not
support a claim that Jira's API is or is not the bottleneck.

What it does support:

> The additional cost observed in these measurements appears to arise less from
> the Jira data itself than from the baseline path's oversized payload, extra
> resource lookup, serialisation and transfer, and the agent-side handling that
> follows.

Put another way:

> JAM did not make Jira REST faster. It reduced the data the agent does not
> need and the extra call path around it, lowering the cost of the overall
> agent workflow.

## Fairness caveats

Two, both necessary for this record to be read correctly.

**1. The baseline can be tuned.** The existing Jira MCP accepts an explicit
field list. A caller who specifies exactly the fields JAM requests would close
most of the payload gap. The 95% figure compares JAM's safe defaults against
the baseline's *defaults* — it is not a claim about a protocol's ceiling. The
tuned comparison is recorded as
[follow-up A](../../architecture/backlog.md#follow-up-benchmark-a--tuned-baseline)
and has not been run; its numbers will be smaller, and that is expected.

**2. The point is not the protocol.** JAM's value is not that it can produce a
small payload — anyone can, by asking correctly. It is that field selection,
pagination, context level, completeness and output budget are decided by
server-side policy rather than by whoever wrote the prompt.

```text
Baseline:  the call is optimal when the agent gets the request right, every time
JAM:       the code makes getting it wrong difficult
```

The measured difference above is what "defaults that hold" looks like in
practice, on a query nobody tuned.

## Cache

Not warranted by this evidence.

JAM's mean tool-side latency is ~2.8 s and the payload problem is solved.
Adding a cache would introduce staleness, invalidation, permission-boundary and
read-after-write consistency concerns for a latency gain this evidence does not
justify. `CachePort` stays in place as a seam; `NoopCache` remains the shipped
implementation. Revisit if real usage identifies a bottleneck these
measurements did not.

## Conclusion

> JAM enforces the level of information an agent needs at the server, and in
> doing so substantially reduced payload and context pressure while preserving
> the same listing information. Across three real-world repetitions it lowered
> both tool latency and wall latency relative to the default Jira MCP read
> path; the largest differences were a roughly 95% payload reduction and the
> elimination of tool-result overflow. Because the existing MCP can also be
> optimised by specifying fields explicitly, JAM's core value is not protocol
> superiority but that **performance and completeness policy is enforced in
> infrastructure code rather than left to the caller's prompt.**
