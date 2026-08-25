# Benchmark

Phase I. Compares JAM against the raw Atlassian MCP on the same workload.

Baseline = existing Atlassian MCP at 100.

Payload / latency:

```
jira_calls_per_task
jira_round_trip_ms
tool_result_bytes
tool_result_tokens
issues_returned
pages_fetched
agent_time_to_next_action
```

Correctness (all must stay at zero):

```
missed_issue_count
stale_read_count
missed_comment_decision
missed_dependency
false_ready_decision
false_done_decision
```

First-release targets:

```
Search payload      <= baseline 30%
Search tool tokens  <= baseline 30%
Jira latency        <= baseline 60%
Critical omission   = 0
Silent truncation   = 0
```

Not implemented yet - `ConsoleTelemetry` already emits `response_bytes`,
`jira_requests` and `pages` per call, which is the raw material for this.
