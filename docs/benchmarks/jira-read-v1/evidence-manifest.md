# Evidence manifest — jira-read-v1

What each file in this directory establishes, what it does not, and its
checksum. Written so that someone citing this benchmark later — in a design
discussion, a rollout argument, or a write-up — can tell exactly how much
weight each file carries.

## Read this first

**The original terminal transcript was not preserved.**

The two `.redacted.txt` files are **reconstructed measurement records**: the
figures reported during the live comparison session, anonymised and written
into a structured form. They are not copies of raw tool output, and this
directory does not contain any.

Consequently:

- These files record measurements that were taken. They are not a byte-level
  artifact of the run that took them.
- The SHA-256 values below establish that a file has not changed **since it was
  written here**. They are integrity values for tracking later edits.
- A SHA-256 value here does **not** establish that a file matches original raw
  output. No such comparison is possible, because no original was kept.

Anyone re-running this comparison should treat these as the figures to
reproduce, not as primary evidence of the original run.

## Files

### `jam-runs.redacted.txt`

`SHA-256: 8ed22dc566c1c59162034e40adbc036dd512213008174f4c513d20c082d760dc`

- **Establishes:** the reported JAM measurements — per-run tool-side and wall
  timings (2,652 / 2,809 / 2,856 ms and 4,537 / 4,833 / 5,672 ms), 17 issues,
  4,621 bytes, ~1,335 estimated tokens, one page, one Jira operation,
  `meta.complete = true`, and that all three runs entered agent context
  without overflow or recovery.
- **Does not establish:** byte-identity with the original terminal output; that
  the token figure is anything other than an estimate derived from payload
  size; that these timings generalise beyond this workload, this instance, or
  this session.

### `baseline-runs.redacted.txt`

`SHA-256: 105287ced12e8dbf59221e2f8591a26f93eaf03b968e56454aa0cec6052bdd5a`

- **Establishes:** the reported baseline measurements — per-run timings
  (3,872 / 5,045 / 4,816 ms and 7,818 / 7,422 / 7,507 ms), the same 17 issues,
  93,320 bytes, ~25,335 estimated tokens, 2+ remote operations, the
  `result exceeds maximum allowed tokens` overflow on all three runs, and the
  breakdown of unrequested metadata including `description` at 11,995 bytes.
- **Does not establish:** byte-identity with the original terminal output;
  that this is the best the existing Jira MCP can do — the runs used its
  **default** field set, and an explicit field list would perform far better;
  that the overflow threshold is a property of the MCP rather than of the
  client's tool-result limit at the time of testing.

### `methodology.md`

`SHA-256: 03b3d4929824f8c5b7a570a100f6e711a487d039eda2f8238b07939aff7a041e`

- **Establishes:** how each figure was collected, that both paths issued their
  own real remote calls with no result reuse between them, and the stated
  limits — asymmetric tool-side reference points, agent overhead inside the
  wall figures, token counts as estimates, client-limit dependence of the
  overflow finding.
- **Does not establish:** that the protocol was executed as described. It is a
  written account, corroborated by the consistency of the figures, not an
  independently verified procedure.

### `results.md`

`SHA-256: f3f96c4799d1f6b581eb05d975192d4feb3b2894102d8901df4d536d24a6cb68`

- **Establishes:** the arithmetic connecting raw measurements to every reported
  percentage — each derivation is written out in full and can be checked
  against the per-run figures; the comparison table; the metadata analysis; the
  two fairness caveats; and the recorded reasoning for deferring cache.
- **Does not establish:** anything the underlying measurements do not. The
  derivations are only as good as the inputs, and the token rows are estimates.
  No statistical claim is made from three runs.

### `README.md`

`SHA-256: cafd608d185f4a43ba6603075a1ca5d53de8469a5b4c1adcaa92eea8115940ed`

- **Establishes:** the summary and reading order, and flags both the
  reconstruction caveat and the untuned-baseline caveat at the point of entry.
- **Does not establish:** anything on its own; it is a pointer to the files
  above.

## Supporting, outside this directory

### Test suite

`npm test` — 86 passed, 3 skipped (opt-in live-Jira integration tests).

- **Establishes:** that the behaviour this benchmark depends on is guarded by
  regression tests — pagination completeness (no page silently dropped),
  completeness metadata (a partial result is never reported as complete),
  output-budget drop order and reporting, and credential non-leakage through
  logs, telemetry, errors and tool results.
- **Does not establish:** any performance property. The tests are correctness
  guards; none of them measures latency or payload.

### Regenerating the checksums

```bash
cd docs/benchmarks/jira-read-v1
sha256sum jam-runs.redacted.txt baseline-runs.redacted.txt methodology.md results.md README.md
```

A mismatch means the file was edited after this manifest was written — which is
legitimate if the manifest is updated in the same change, and a problem if it
was not.

This manifest deliberately carries no checksum of itself.

## Privacy

Every file here uses placeholders: `PROJECT`, `PROJECT-101`, `CURRENT_USER`,
`https://example.atlassian.net`, `C:\projects\target-project`. Issue summaries
are omitted entirely — they support none of the figures. No real project key,
issue key, account id, cloud id, email address, host name, local path, token or
credential appears in this directory.
