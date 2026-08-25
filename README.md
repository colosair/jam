# JAM — Jira Agent MCP

An agent-facing Jira access layer for Claude Code and Codex.

JAM is not a thin Jira wrapper. It exposes **three** read tools and takes over the
decisions an agent should not be making: which Jira fields to request, when to
paginate, when to read the comment thread, and what to do when a result is too
big. The payoff is that everyday Jira reads stay cheap, important judgements
still get full context, and every teammate gets the same policy.

> **V3 Architecture, V1 Implementation, Stable External Contract.**

## The three tools

| Tool | Use it for | Returns |
|---|---|---|
| `jira_search` | listing, discovery, "what's open", picking candidates | key, summary, status, assignee, priority, updated, labels, components |
| `jira_context` | readiness, blockers, dependencies, priority | the above + issue type, parent, subtasks, links (with `blocksThisIssue`), whitelisted custom fields |
| `jira_full` | agreement, contract, approval, closure | the above + description and the full comment thread |

Two rules make this work:

1. **A `jira_search` result is never complete issue context.** Don't conclude
   agreement, approval, or done-ness from it.
2. **Nothing is truncated silently.** Every result carries a `meta` block; if
   `meta.complete` is `false`, something was dropped and `meta.reason` /
   `meta.overflow` say what.

```json
{
  "issues": [{ "key": "PROJECT-237", "summary": "Example", "status": "해야 할 일" }],
  "meta": { "level": "search", "complete": true, "pagesFetched": 1, "fetchedAt": "..." }
}
```

## Install

```bash
npm ci && npm run build
```

Set credentials (never commit them — `.env` is gitignored):

```bash
export JIRA_BASE_URL=https://example.atlassian.net
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...   # https://id.atlassian.com/manage-profile/security/api-tokens
```

On Windows, `scripts/setup.ps1` does the version check, install, build and
doctor run in one shot:

```powershell
./scripts/setup.ps1
```

## Verify

```bash
node dist/index.js doctor
```

`jam doctor` answers one question fast — is this a Jira problem, a credential
problem, or a local setup problem?

```text
[OK]   Node runtime - v20.11.0
[OK]   Project config - .jira-agent/project.yaml (project=PROJECT)
[OK]   Jira project key - PROJECT
[OK]   Credentials present - you@example.com @ https://example.atlassian.net
[OK]   Jira base URL - https://example.atlassian.net
[OK]   MCP server startup - 3 tools registered
[OK]   Jira authentication - Your Name
[OK]   JQL search / PROJECT access - reachable (sample PROJECT-237)
[OK]   Issue detail endpoint - read PROJECT-237
```

## Commands

```text
jam serve     Run the MCP server over stdio (default; what Claude Code / Codex launch)
jam doctor    Diagnose config, credentials and Jira connectivity
jam setup     Install, build, then run doctor
```

## Wire it into a project

Put these in the **project** repo, not a copy of JAM:

`.mcp.json`

```json
{
  "mcpServers": {
    "jam": {
      "command": "node",
      "args": ["/absolute/path/to/jira-agent-mcp/dist/index.js", "serve"],
      "env": {
        "JIRA_BASE_URL": "${JIRA_BASE_URL}",
        "JIRA_EMAIL": "${JIRA_EMAIL}",
        "JIRA_API_TOKEN": "${JIRA_API_TOKEN}"
      }
    }
  }
}
```

`.jira-agent/project.yaml` — project policy only, never credentials. See this
repo's [`.jira-agent/project.yaml`](.jira-agent/project.yaml) for the annotated
version; the minimum is:

```yaml
version: 1
project:
  key: PROJECT   # target-project - the Jira key is the cohort code
```

`CLAUDE.md` / `AGENTS.md` — keep it short; the tool descriptions carry the detail:

```text
For Jira reads, use the JAM tools.

- Discovery / listing            -> jira_search
- Readiness / blocker /
  dependency / priority          -> jira_context
- Agreement / contract /
  approval / closure             -> jira_full

Do not use raw Atlassian Jira search when JAM can answer the request.
A search result is not complete issue context.
If meta.complete is false, say so instead of answering as if it were.
```

JAM does not replace the Atlassian MCP. That one keeps Confluence, writes, and
anything JAM does not cover; JAM becomes the default path for Jira **reads**.

## Configuration reference

| Key | Default | What it does |
|---|---|---|
| `project.key` | — | Jira project key, used by `doctor` |
| `search.pageSize` | 50 | Page size sent to Jira |
| `search.maxPages` | 20 | Safety stop for `scope: "complete"`; hitting it is reported |
| `fields.lite` | summary, status, assignee, priority, updated, labels, components | SEARCH field whitelist |
| `fields.context` | parent, subtasks, issuelinks, issuetype | added at CONTEXT |
| `customFields` | `[]` | `{ id: customfield_NNNNN, name: Display }`, surfaced from CONTEXT up |
| `output.*Tokens` | 2000 / 5000 / 8000 | per-level output budgets |
| `telemetry.enabled` | `true` | one metrics line per call on stderr |

`description`, `comment`, `attachment` and `changelog` are stripped from
`fields.lite` and `fields.context` even if a config asks for them — that
whitelist is the point of the tool.

## Development

```bash
npm test                 # unit + contract tests
npm run build            # tsc
```

Live Jira tests are opt-in:

```bash
JAM_INTEGRATION=1 npm test
```

Layout follows ports & adapters — `src/domain`, `src/policy`, `src/ports`,
`src/adapters`, `src/application`, `src/mcp`. The full design, including the
phases that are deliberately deferred (cache, remote transport, Rovo, OAuth),
is in [`docs/architecture/jira-agent-mcp-design.md`](docs/architecture/jira-agent-mcp-design.md).

## Security

- Credentials come from the environment through `CredentialPort` and are read
  only where the HTTP request is built.
- The `Authorization` header, the API token, and raw Jira error payloads never
  appear in logs, telemetry, or tool results.
- `stdout` is reserved for the MCP protocol; all diagnostics go to `stderr`.
- Each teammate authenticates as themselves. Do not put the team behind one
  shared Jira service account — JAM shares policy, not permissions.
