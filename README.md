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
  "issues": [{ "key": "PROJECT-101", "summary": "Example issue", "status": "To Do" }],
  "meta": { "level": "search", "complete": true, "pagesFetched": 1, "fetchedAt": "..." }
}
```

## Setup

JAM is not published to npm yet. The package layout builds and passes isolated
tarball smoke tests, but the `npx` paths below become live only after
publication — until then, use the development route in
[Development](#development).

**For a person**, once per machine:

```bash
npx --yes @jam-mcp/bootstrap@1.0.0 init
```

Choose whether you're *using* JAM (runs the published package) or *developing*
it (runs your local checkout), authenticate to Jira once, and you're done. From
then on it's just `claude` or `codex` inside any wired project.

**For a coding agent** — see [Setup with a coding agent](#setup-with-a-coding-agent).

Authenticate once, and the credentials live where your operating system keeps
them for you — never in a repo:

```bash
jam auth login
```

Paste any page URL from your Jira site, your Atlassian account email, and an
[API token](https://id.atlassian.com/manage-profile/security/api-tokens). JAM
checks the credentials against Jira before storing anything, and the token is
never echoed. `jam auth logout` removes them again.

This is also what makes JAM work in an editor started from a Dock or Start menu:
that process never sourced a shell profile, so it has nothing to inherit — but
it can still read what the OS holds for you.

Environment variables remain supported as an explicit override, for CI and for
existing setups, and they win over the stored credentials:

```bash
export JIRA_BASE_URL=https://your-site.atlassian.net
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...
```

On Windows a value set with `setx` doesn't reach `process.env` until a new
shell, so JAM falls back to the Windows **User** environment
(`HKCU\Environment`). `jam doctor` shows which source supplied it
(`process` / `user-env` / `mixed`).

## Setup with a coding agent

If you are Claude Code, Codex, or another terminal-capable coding agent asked
to set JAM up in a project, **use the official path** rather than working out
an installation from this README:

```bash
npx --yes @jam-mcp/bootstrap@1.0.0 setup --agent
```

or, to inspect before acting:

```bash
jam setup plan --json                       # what would change; changes nothing
jam setup apply --non-interactive --json    # execute it
jam doctor --json                           # verify
```

Each returns a single JSON document on stdout with a stable status code. Branch
on the code; never parse prose.

Do **not**:

- copy JAM source into the project
- use `npm link` for consumer setup
- modify global `PATH` or user environment variables
- write Jira credentials into any repository file
- guess a Jira project key from a repo or directory name
- overwrite or remove unrelated `.mcp.json` entries
- assemble `project.yaml` or `.mcp.json` yourself

Stop only where a person is genuinely required — `JAM_PROJECT_SELECTION_REQUIRED`
(ask which Jira project) and `JAM_AUTH_REQUIRED` (ask them to authenticate).
Finish with `jam doctor --json`.

## Commands

```text
jam serve                    Run the MCP server over stdio (what Claude Code / Codex launch)
jam doctor                   Diagnose config, credentials and Jira connectivity
jam setup [--project KEY] [--migrate]
                             Wire up this project and verify (--migrate rewrites a
                             legacy jam entry, only if its target resolves)
jam runtime                  Show which JAM build this machine runs
jam runtime use package | development <path>
                             Change it (writes ~/.jam/config.yaml only, never a project)
jam auth login               Store Jira credentials in this user's OS secret store
jam auth status              Whether Jira credentials are configured
jam auth logout              Remove the stored credentials
```

`jam doctor` answers one question fast — is this a Jira problem, a credential
problem, or a local setup problem?

```text
[OK]   Node runtime - v20.11.0
[OK]   Project config - .jira-agent/project.yaml (project=PROJECT)
[OK]   Jira project key - PROJECT
[OK]   Credentials present - you@example.com @ https://your-site.atlassian.net (user-env)
[OK]   MCP server startup - 3 tools registered
[OK]   Jira authentication - Your Name
[OK]   JQL search / PROJECT access - reachable (sample PROJECT-101)
```

`jam serve` runs local checks only before starting, so Jira's latency never
delays your editor's startup; `jam doctor` and `jam setup` add the live
connectivity checks.

## What gets written

`jam setup` produces two files in the project, and nothing else:

`.mcp.json` — goes through the launcher, so it names no machine-specific path
and is safe to commit:

```json
{
  "mcpServers": {
    "jam": { "command": "npx", "args": ["--yes", "@jam-mcp/launcher@1.0.0", "serve"] }
  }
}
```

Existing entries for other MCP servers are always preserved. An existing `jam`
entry is left alone unless you pass `--migrate` — and `--migrate` first checks
that the package it would point at actually resolves. If it cannot be verified,
the migration is refused and your `.mcp.json` is left exactly as it was.

`.jira-agent/project.yaml` — project policy only, never credentials. See
[`.jira-agent/project.yaml.example`](.jira-agent/project.yaml.example); the
minimum is:

```yaml
version: 1
project:
  key: PROJECT
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

Absence of evidence in Jira is not evidence of absence. If an issue has no
supporting comments but references an external canonical source (an MR/PR,
a spec, a contract doc, Confluence), do not conclude "not agreed" or "cannot
start" — check that source, or report that Jira alone cannot settle it.
```

That last rule comes from a real miss: a complete `jira_full` read with zero
comments is a complete read *of Jira*, which is not the same as a complete
record of the decision. This repo's own
[`CLAUDE.md`](CLAUDE.md#absence-of-evidence-is-not-evidence-of-absence) carries
the longer version with a worked example.

JAM does not replace the Atlassian MCP. That one keeps Confluence, writes, and
anything JAM does not cover; JAM becomes the default path for Jira **reads**.

## Design documents

| Document | Covers |
|---|---|
| [Distribution and bootstrap](docs/architecture/distribution-and-bootstrap.md) | Package/development runtimes, the launcher, plan/apply, version policy, roadmap |
| [ADR: unified runtime and agent setup](docs/decisions/adr-unified-runtime-and-agent-setup.md) | Why setup branches early and converges, and what that cost |
| [Setup UX contract](docs/operations/setup-ux.md) | CLI symbols, colour, prompts, `NO_COLOR`/non-TTY, JSON output rules |
| [JAM design of record](docs/architecture/jira-agent-mcp-design.md) | The three-tool contract and read policy |
| [ADR: Jira read optimization](docs/decisions/adr-jam-jira-read-optimization.md) | Why reads are mediated at all |
| [Benchmark: jira-read-v1](docs/benchmarks/jira-read-v1/README.md) | Measured payload and latency evidence |
| [Architecture backlog](docs/architecture/backlog.md) | Deferred work, with reasons |

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

An npm workspaces monorepo:

```text
packages/server      @jam-mcp/server      CLI, setup core, MCP tools  (bin: jam)
packages/launcher    @jam-mcp/launcher    which JAM build runs        (bin: jam-launcher)
packages/bootstrap   @jam-mcp/bootstrap   zero-install first run      (bin: jam-bootstrap)
```

```bash
npm ci
npm run build            # all three, in dependency order
npm test                 # unit + contract tests
npm run pack:all         # tarballs into private/packs
npm run smoke            # install those tarballs into isolated sandboxes
```

To use your checkout instead of the published package, from anywhere:

```bash
node packages/server/dist/index.js runtime use development /path/to/this/checkout
```

Live Jira tests are opt-in:

```bash
JAM_INTEGRATION=1 npm test
```

Inside `packages/server`, layout follows ports & adapters — `src/domain`,
`src/policy`, `src/ports`, `src/adapters`, `src/application`, `src/mcp`, with
`src/bootstrap` holding the detect/plan/apply setup core. See the
[design documents](#design-documents) above.

## Security

- Credentials come from `CompositeCredentialProvider` (process env, then this
  user's OS secret store, then Windows User env) through `CredentialPort`, and
  are read only where the HTTP request is built. Nothing is stored in a project
  file. On macOS that store is the login Keychain, on Linux libsecret, and on
  Windows a file encrypted to your user account with DPAPI.
- The `Authorization` header, the API token, and raw Jira error payloads never
  appear in logs, telemetry, `describe()`, config files, or tool results.
- `stdout` is reserved for the MCP protocol; all diagnostics go to `stderr`.
- Each teammate authenticates as themselves. Do not put the team behind one
  shared Jira service account — JAM shares policy, not permissions.
- `jam setup` never records credentials in `.jira-agent/project.yaml` or
  `.mcp.json`, never overwrites another MCP server's entry, and never touches
  your PATH or other user environment variables - those stay under your
  control.
