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

## Absence of evidence is not evidence of absence

A complete JAM read proves what Jira holds — not what was decided. When an
issue points at an external canonical source (a GitHub/GitLab issue, an MR/PR,
a spec or contract document, Confluence, another issue), an empty Jira comment
thread means the record lives elsewhere, not that nothing was agreed.

So when `jira_full` returns no supporting comments **and** the issue references
an external canonical source:

- Do not conclude "not agreed", "not approved", or "cannot start".
- Check the external source if you can reach it, and judge from that.
- If you cannot reach it, report that Jira alone is not sufficient to decide,
  and name the source that has to be checked.

This applies only to issues that actually reference an external source. An
issue with no such reference does not warrant an open-ended hunt.

Wrong:

```text
No agreement recorded. Cannot start.
```

Right:

```text
Jira holds no agreement record for this issue (jira_full, commentsComplete=true,
0 comments). The description names an external contract document as the source of
record, so Jira alone cannot settle whether this is ready to start — that document
needs to be checked.
```

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
