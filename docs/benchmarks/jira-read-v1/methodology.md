# Methodology — jira-read-v1

## Purpose

Establish, against a real Jira instance rather than a mock, what an agent
actually pays to answer a routine listing question through JAM versus through
the existing Jira MCP's default read path — and whether the answer it gets back
is equivalent.

The question is not "which protocol is faster in principle". It is "what does
this cost in the environment the team actually works in".

## Workload

A single list-style JQL query — open issues in one project, ordered by most
recently updated — issued to both paths.

Held identical across both:

- the same JQL
- the same Jira project
- the same Jira account and permissions
- the same machine, network, and session
- the same 17 issues in the result

**Each run issued its own remote call.** No result from the first approach was
reused, replayed, or served from cache to the second. JAM ran with `NoopCache`,
which is its shipped default and performs no caching at all.

Three repetitions per approach, run in the same session.

## What was measured, and how

### Wall latency

```text
timestamp immediately before the tool call
        ↕
timestamp of the agent turn following the tool result
```

This interval contains the MCP round trip, the remote Jira request, payload
transfer, and some agent-side processing. It is therefore **not** pure tool
latency — it is an upper bound.

It is included because a comparable agent overhead sits inside both figures, so
the two remain comparable to each other even though neither is a clean
protocol measurement. It is also the number that corresponds to what a person
waiting on the agent actually experiences.

### Tool-side latency

Derived from each path's own reported server-processing / result timestamps.

**Limitation, stated plainly:** the two paths do not expose perfectly
symmetric reference points. JAM reports its own instrumented duration; the
baseline's figure is derived from what that tool exposes. The two are close
enough to compare in the same order of magnitude, and both were collected
consistently within their own path across all three runs, but they are not
guaranteed to be measuring from byte-identical boundaries.

Treat tool-side latency as a directional comparison, not as a certified
protocol benchmark.

### Payload

Byte and character count of the tool result as delivered to the agent. This is
a direct measurement, not an estimate.

### Tool-result tokens

**Estimated, not measured.** Derived from payload size, not from a tokenizer
run against the exact model in use. The estimates are reported with a `~`
prefix throughout and should be read as order-of-magnitude figures supporting
the payload measurement, not as independent evidence.

The payload byte counts are the reliable number here. The token figures track
them closely, as expected.

### Remote operation count

Number of distinct remote operations the path performs to satisfy one call, as
observable from each tool's own reporting.

### Overflow

Whether the tool result entered the agent's context directly, or was rejected
by the client's tool-result size limit and required recovery work.

This depends on the client's tool-result limit as configured at the time of
testing. A client with a different limit would draw the line in a different
place. What the measurement establishes is that under the limit this team
actually runs against, one path fit and the other did not — three times out of
three.

## What this benchmark is not

- Not a precise protocol-level benchmark. Agent overhead is inside the wall
  figures, and the tool-side reference points are not perfectly symmetric.
- Not a statistical study. Three runs per approach establish a consistent
  direction, not a distribution. No significance claims are made.
- Not a comparison of tuned configurations. The baseline used its **default**
  field set. See the fairness caveats in [results.md](results.md) and
  [follow-up A](../../architecture/backlog.md) for the tuned comparison, which
  has not been run yet.
- Not a measurement of Jira REST latency in isolation. Nothing here separates
  Jira's own processing time from the transport and handling around it.

## Anonymisation

Every figure in this directory is reproduced with identifiers replaced by
placeholders: `PROJECT`, `PROJECT-101`, `CURRENT_USER`,
`https://example.atlassian.net`, `C:\projects\target-project`. Issue summaries
are omitted entirely — they establish nothing that the counts and byte sizes do
not. No account id, cloud id, token, or credential appears in any file here.
