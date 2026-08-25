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
npm ci && npm run build && npm link
```

`npm link` puts `jam` on PATH so `.mcp.json` entries can say `"command":
"jam"` instead of an absolute path to this checkout - required once per
machine. If `npm link`'s target directory (`npm config get prefix`) isn't
already on your PATH, add it once yourself; JAM never touches your PATH or
other user environment variables on its own.

Set credentials (never commit them — `.env` is gitignored):

```bash
export JIRA_BASE_URL=https://example.atlassian.net
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...   # https://id.atlassian.com/manage-profile/security/api-tokens
```

On Windows, a value set with `setx` (System Properties → Environment
Variables) doesn't appear in `process.env` until a new shell — JAM works
around exactly that gap: if a credential is missing from the current
process's environment, it falls back to the Windows **User** environment
(`HKCU\Environment`) before giving up. `jam doctor`'s "Credentials present"
line shows which source actually supplied it (`process` / `user-env` /
`mixed`).

`scripts/setup.ps1` does the version check, install and build in one shot;
`jam setup` (below) is what wires up an actual project.

```powershell
./scripts/setup.ps1
```

## Bring up a project

From the **project** repo (e.g. target-project), not this checkout:

```bash
jam setup --project PROJECT
```

This:

1. Confirms `jam` is reachable on PATH (warns if not).
2. Writes `.jira-agent/project.yaml` with `project.key: PROJECT` — but
   only because `--project` said so explicitly. With no existing config and
   no `--project`, no `JAM_PROJECT_KEY` env var, and no matching entry in
   `~/.jira-agent/presets.yaml`, JAM refuses to guess and instead lists the
   Jira projects your account can see, so you can re-run with the right key.
3. Merges a PATH-based `jam` entry into `.mcp.json`, creating the file if
   needed and leaving every other MCP server (and any existing `jam` entry)
   untouched.
4. Runs the full diagnostic gate (below).

After that, everyday use is just `claude` — `jam serve` bootstraps
`.jira-agent/project.yaml` on its own once a decidable source exists (an
existing file, `JAM_PROJECT_KEY`, or a preset), and never re-runs the live
Jira checks on every startup (see Health checks below).

## Verify

```bash
node dist/index.js doctor
```

`jam doctor` answers one question fast — is this a Jira problem, a credential
problem, or a local setup problem? It's read-only: it never writes
`project.yaml` or `.mcp.json` (that's `jam setup`'s job).

```text
[OK]   Node runtime - v20.11.0
[OK]   Project config - .jira-agent/project.yaml (project=PROJECT)
[OK]   Jira project key - PROJECT
[OK]   Credentials present - you@example.com @ https://example.atlassian.net (user-env)
[OK]   Jira base URL - https://example.atlassian.net
[OK]   MCP server startup - 3 tools registered
[OK]   Jira authentication - Your Name
[OK]   JQL search / PROJECT access - reachable (sample PROJECT-237)
[OK]   Issue detail endpoint - read PROJECT-237
```

## Health checks

One check core (`runHealthGate`) backs both commands, at two depths:

- **boot** — `jam serve` runs this on every startup: Node version, config,
  project key, credential presence, base URL shape, MCP wiring. All local, no
  network call, so it never adds Jira's latency to Claude Code's own startup.
  A failed boot check means the MCP server never calls `connect()` — no
  half-started server.
- **full** — `jam doctor` and `jam setup` add live Jira connectivity: auth,
  a sample JQL search against the configured project, and a sample issue
  read.

## Commands

```text
jam serve                    Run the MCP server over stdio (default; what Claude Code / Codex launch)
jam doctor                   Diagnose config, credentials and Jira connectivity (read-only, full checks)
jam setup [--project KEY]    Wire up this project (project.yaml, .mcp.json) and run doctor
```

## Wire it into a project

`jam setup` (above) does this for you. What it produces:

`.mcp.json` — PATH-based, so it's safe to commit and share across machines:

```json
{
  "mcpServers": {
    "jam": { "command": "jam", "args": ["serve"] }
  }
}
```

Credentials are never written here — `jam serve` resolves them itself
(process env, then Windows User env) at startup.

`.jira-agent/project.yaml` — project policy only, never credentials. See this
repo's [`.jira-agent/project.yaml`](.jira-agent/project.yaml) for the annotated
version; the minimum, and what `jam setup` generates, is:

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

### Presets, for setting up several projects without typing `--project` each time

`~/.jira-agent/presets.yaml` (not part of any project repo):

```yaml
projects:
  - match: 'C:\projects\target-project'   # absolute path to the project root
    key: PROJECT
```

`jam setup` / `jam serve` check this only when a project has no
`project.yaml` yet and no `--project`/`JAM_PROJECT_KEY` was given — matched by
exact path (case-insensitive on Windows). JAM never infers a key from a repo
or folder name; a preset is still an explicit source, just a reusable one.

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

- Credentials come from `CompositeCredentialProvider` (process env, then
  Windows User env) through `CredentialPort`, and are read only where the
  HTTP request is built.
- The `Authorization` header, the API token, and raw Jira error payloads never
  appear in logs, telemetry, `describe()`, config files, or tool results.
- `stdout` is reserved for the MCP protocol; all diagnostics go to `stderr`.
- Each teammate authenticates as themselves. Do not put the team behind one
  shared Jira service account — JAM shares policy, not permissions.
- `jam setup` never records credentials in `.jira-agent/project.yaml` or
  `.mcp.json`, never overwrites another MCP server's entry, and never touches
  your PATH or other user environment variables - those stay under your
  control.
