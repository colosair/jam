# Benchmark: Jira read, v1

Real-world comparison of one routine listing query answered through JAM's
`jira_search` versus the existing Jira MCP's default read path. Same JQL, same
project, same 17 issues, same session, three repetitions each.

## Headline

| Metric | JAM | Baseline | Change |
|---|---:|---:|---:|
| Tool latency (mean) | 2,772 ms | 4,578 ms | 39.4% lower |
| Wall latency (mean) | 5,014 ms | 7,582 ms | 33.9% lower |
| Payload | 4,621 B | 93,320 B | 95.0% smaller / ~20.2× |
| Tool-result tokens *(est.)* | ~1,335 | ~25,335 | ~94.7% fewer |
| Entered agent context directly | yes | 0/3 — overflowed | JAM only |
| Listing information missing | 0 | 0 | equivalent |

The speed difference is real but secondary. The result that changes how the
tool is used is the last two rows together: the baseline's result exceeded the
client's tool-result limit on all three runs and needed recovery work before it
could be read at all, while JAM returned the same 17 issues, with nothing a
listing judgement needs left out, small enough to use directly.

## Read in this order

| File | What it is |
|---|---|
| [methodology.md](methodology.md) | How each number was collected, and what it does not establish |
| [results.md](results.md) | Every measurement, the derivations behind each percentage, metadata analysis, fairness caveats, conclusion |
| [jam-runs.redacted.txt](jam-runs.redacted.txt) | JAM's three runs, structured |
| [baseline-runs.redacted.txt](baseline-runs.redacted.txt) | The baseline's three runs, structured |
| [evidence-manifest.md](evidence-manifest.md) | What each file proves, what it does not, and its SHA-256 |

## Two things to know before citing this

**The measurement records are reconstructions.** The original terminal
transcript was not preserved. The `.redacted.txt` files are anonymised,
structured records of the figures reported during the live session — not
copies of raw output. [evidence-manifest.md](evidence-manifest.md) states this
precisely for each file.

**The baseline was untuned.** This compares JAM's safe defaults against the
existing MCP's *default* field set. That MCP accepts an explicit field list,
and a caller who specifies exactly what JAM requests would close most of the
payload gap. The tuned comparison is
[follow-up A](../../architecture/backlog.md#follow-up-benchmark-a--tuned-baseline)
and has not been run.

JAM's argument is therefore not that the protocol is superior. It is that field
selection, pagination, completeness and output budget are enforced by
server-side policy instead of depending on the caller getting each request
right. See [the ADR](../../decisions/adr-jam-jira-read-optimization.md) for the
decision this evidence supports.

## Scope

One listing query. Not a whole workflow, not a tuned baseline, not a
statistical study, not a protocol-level benchmark. Follow-ups for the first two
are recorded in [the architecture backlog](../../architecture/backlog.md) and
must not be merged into this record.

All identifiers are anonymised throughout: `PROJECT`, `PROJECT-101`,
`CURRENT_USER`, `https://example.atlassian.net`. No credentials, account ids,
or cloud ids appear anywhere in this directory.
