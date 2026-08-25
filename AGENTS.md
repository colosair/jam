# JAM (Jira Agent MCP)

## Jira reads

Use the JAM tools for Jira. Pick by what the answer will be used for:

- Discovery / listing / current status → `jira_search`
- Readiness / blocker / dependency / priority → `jira_context`
- Agreement / contract / approval / closure → `jira_full`

Do not use raw Atlassian Jira search when JAM can answer the request. A
`jira_search` result is not complete issue context — never conclude from it that
something is agreed, approved, unblocked, or done.

Every result carries a `meta` block. If `meta.complete` is `false`, report the
answer as partial rather than answering as if it were whole.

## This repo

TypeScript, ESM, Node 20+. Ports & adapters: `src/domain` → `src/policy` →
`src/ports` → `src/adapters`, with `src/application` orchestrating and `src/mcp`
exposing the tools.

- The external contract is exactly three tools. Adding or renaming one is a
  breaking change; internal refactors must not touch it.
- Raw Jira DTOs stop at `src/adapters/jira-cloud/mapper.ts`.
- Credentials never reach a log, telemetry line, or tool result.
- Silent truncation is a release blocker. Anything dropped must show up in
  `CompletenessMeta`.
- `stdout` belongs to the MCP protocol — diagnostics go to `stderr`.

```bash
npm test
npm run build
node dist/index.js doctor
```

Design of record: `docs/architecture/jira-agent-mcp-design.md`.
