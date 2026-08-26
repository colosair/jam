# @jam-mcp/server

JAM (Jira Agent MCP) itself: the MCP server, the setup core, and the `jam` CLI.

JAM is an agent-facing Jira **read** layer. It takes over the decisions an agent
should not be making — which fields to request, when to paginate, when to read
the comment thread, what to do when a result is too big — so everyday reads stay
cheap and important judgements still get full context.

## The three tools

The external contract is exactly three tools. Adding or renaming one is a
breaking change.

| Tool | Use it for |
|---|---|
| `jira_search` | listing, discovery, "what's open", picking candidates |
| `jira_context` | readiness, blockers, dependencies, priority |
| `jira_full` | agreement, contract, approval, closure |

A `jira_search` result is never complete issue context — nothing about
agreement, approval, or done-ness follows from it.

## Evidence boundary

Every result carries a `meta` block, and nothing is ever truncated silently.

`meta.complete` means **JAM finished the Jira retrieval with no known loss**. It
is not a statement about the project: not readiness, not "unblocked", not "the
whole story". What JAM did not look at is named in the same block —
`evidenceScope` and `limitations` call out the repository, external sources, and
dependencies that live outside Jira. `provenance` and `source` say where the
records came from.

So an empty comment thread on a complete read is a complete read *of Jira*, not
proof that nothing was agreed. If the issue points at an external canonical
source, that source is what settles the question.

## Running it

Normally you don't run this package directly — your coding agent launches
[`@jam-mcp/launcher`](https://www.npmjs.com/package/@jam-mcp/launcher), which
resolves which JAM build this machine runs and dispatches here. Going through
the launcher is what keeps a committed `.mcp.json` free of machine-specific
paths.

The `jam` CLI is the same binary:

```text
jam serve      Run the MCP server over stdio
jam doctor     Diagnose config, credentials and Jira connectivity
jam setup      Wire up JAM and verify (personal by default; --shared for the team)
jam auth login Store Jira credentials in this user's OS secret store
jam runtime    Show or change which JAM build this machine runs
```

Credentials come from the process environment or this user's OS secret store —
never from a repository file — and never appear in logs, telemetry, or tool
results. `stdout` is reserved for the MCP protocol and for JSON output;
diagnostics go to `stderr`.

## More

- [Repository README](https://github.com/colosair/jam#readme)
- [JAM design of record](https://github.com/colosair/jam/blob/main/docs/architecture/jira-agent-mcp-design.md)
