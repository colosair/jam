# JAM — Jira Agent MCP

An agent-facing Jira access layer for Claude Code and Codex.

[![CI](https://github.com/colosair/jam/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/colosair/jam/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@jam-mcp/bootstrap)](https://www.npmjs.com/package/@jam-mcp/bootstrap)
[![node](https://img.shields.io/node/v/@jam-mcp/server)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@jam-mcp/server)](LICENSE)

JAM is not a thin Jira wrapper. It exposes **three** read tools plus a checked
write path, and takes over the
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

Three rules make this work:

1. **A `jira_search` result is never complete issue context.** Don't conclude
   agreement, approval, or done-ness from it.
2. **Nothing is truncated silently.** Every result carries a `meta` block; if
   `meta.complete` is `false`, something was dropped and `meta.reason` /
   `meta.overflow` say what.
3. **A complete read is a complete *read*.** `meta.complete` says JAM finished
   the Jira retrieval with no known loss. What it did not look at is in the
   same block: `evidenceScope` and `limitations` name the repository and every
   external source. Jira evidence is what JAM answers with; execution reality
   is somebody else's question.

```json
{
  "issues": [{ "key": "PROJECT-101", "summary": "Example issue", "status": "To Do" }],
  "meta": {
    "level": "search",
    "complete": true,
    "pagesFetched": 1,
    "fetchedAt": "...",
    "source": "jira",
    "provenance": "live",
    "evidenceScope": "jira-records-only",
    "limitations": ["REPOSITORY_NOT_EVALUATED", "EXTERNAL_SOURCES_NOT_EVALUATED", "NON_JIRA_DEPENDENCIES_NOT_EVALUATED"]
  }
}
```

## Writing to Jira

Two tools, and they are two on purpose.

| Tool | What it does |
|---|---|
| `jira_write_plan` | reads the issue, checks the change is possible, describes what would happen. **Changes nothing.** |
| `jira_write_apply` | takes the `planId` and nothing else, makes the change, then reads the issue back to confirm it |

```json
{ "key": "PROJECT-123", "operation": "status.transition", "input": { "status": "Done" } }
```

There is no way to write to Jira without planning first: `jira_write_apply`
accepts a plan handle and no payload, so there is no parameter through which an
agent could smuggle a change JAM has not looked at. What "Done" means is settled
during planning — JAM asks Jira which transitions this issue actually offers and
resolves the id, rather than guessing one from a status name.

Five operations, and a fixed field whitelist:

```text
comment.add        { "text": "..." }         plain text; JAM converts it, ADF is not accepted
field.update       summary, priority, labels, components
status.transition  { "status": "Done" }      matched against Jira's available transitions
assignee.update    { "assignee": "..." }     resolved against Jira's user directory
issue.create       issueType, summary + description, priority, labels, components
```

`assignee.update` never sends the name you pass. Jira's user search is a
substring match, so JAM treats what comes back as candidates and assigns only
when exactly one matches exactly — an exact display name, case aside, or an
accountId. Anything less comes back as a refusal with the candidates attached,
because picking one of several people is somebody's issue assigned to the wrong
colleague. JAM also asks Jira whether that person may hold this issue, before
planning and again before writing, and confirms the result on the accountId
rather than on the display name — two people can share a name. Unassigning and
assigning at creation are not in this version.

`issue.create` takes no `key` — there is no issue yet — and no project either:
the new issue goes into the project this workspace is bound to. Planning reads
Jira's create schema for that project first, so an issue type Jira does not
offer, a priority outside its allowed values, or a create screen that requires
a field JAM cannot set are all refused with the alternatives attached, before
anything is sent. Assignee, parent and custom fields are not settable.

### What stops a write going wrong

**Scope.** Writes stay inside the Jira project this workspace is bound to. A key
from another project is refused by JAM before a request is made, not left to
come back as an unexplained 403.

**Staleness.** A plan records what the issue looked like when it was made. If
the issue moves before apply, you get `JAM_WRITE_CONFLICT` and nothing is
written — plan again against the new state rather than forcing the old one
through.

**Confirmation.** Jira accepting a request is not the same as the issue having
changed: a workflow rule can land a transition somewhere else, a screen
configuration can drop a field update. So apply reads the issue back and checks
the intended result is really there. A write JAM could not verify is never
reported as done.

**No blind retries.** A request that times out may already have been applied,
and resending it is how one comment becomes two. An ambiguous failure is
`JAM_WRITE_UNCERTAIN`, which means read the issue — not try again.

| Code | What to do |
|---|---|
| `JAM_WRITE_SCOPE_VIOLATION` | the key is outside the configured project |
| `JAM_WRITE_OPERATION_NOT_ALLOWED` / `JAM_WRITE_FIELD_NOT_ALLOWED` | not part of the write surface |
| `JAM_WRITE_TRANSITION_NOT_AVAILABLE` | pick one of the transitions named in the error |
| `JAM_WRITE_CONFLICT` / `JAM_WRITE_PLAN_EXPIRED` | plan again |
| `JAM_WRITE_VERIFICATION_FAILED` | Jira accepted it, the issue does not show it — read the issue |
| `JAM_WRITE_UNCERTAIN` | read the issue; **do not** re-apply |

Not in this release: creating or deleting issues, bulk changes, editing or
deleting comments, worklogs, attachments, links, assignee, and custom fields.
The Atlassian MCP still covers those.

See [ADR: the Jira write plane](docs/decisions/adr-jira-write-plane.md) for why
it is shaped this way.

## Setup

You need Node.js 20 or newer. Nothing has to be installed globally — every
command below reaches for a published package through `npx` as it needs one:
[`@jam-mcp/bootstrap`](https://www.npmjs.com/package/@jam-mcp/bootstrap) for the
zero-install first run,
[`@jam-mcp/launcher`](https://www.npmjs.com/package/@jam-mcp/launcher) as the
runtime entry your coding agent registers, and
[`@jam-mcp/server`](https://www.npmjs.com/package/@jam-mcp/server) for JAM
itself — the MCP server, the setup core and the CLI they all reach.

**For a person**, once per machine:

```bash
npx --yes @jam-mcp/bootstrap@1.3.2 init
```

Choose whether you're *using* JAM (runs the published package) or *developing*
it (runs your local checkout), authenticate to Jira once, and you're done. From
then on it's just `claude` or `codex` inside any wired project.

**For a coding agent** — see [Setup with a coding agent](#setup-with-a-coding-agent).

`jam` is a short command you can opt into; JAM does not need it. It comes from
installing the launcher globally, and everything it runs still goes through the
runtime you chose above:

```bash
npm install -g @jam-mcp/launcher@1.3.2
```

Without it, the same commands are `npx --yes @jam-mcp/launcher@1.3.2 <command>`.
Nothing else changes — not your editor's wiring, not a shared `.mcp.json`, not
a teammate who never installed it.

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
npx --yes @jam-mcp/bootstrap@1.3.2 setup --agent
```

**If you are reading this inside a clone of this repository** — because someone
handed you the GitHub URL and asked you to apply JAM — then this checkout is
not the installation. The target is the project the user is working in: change
to that directory and run the command above. Building this repository installs
nothing; a development checkout is for people changing JAM itself, and belongs
only to an explicit request to do that.

Setting JAM up is local tooling, not project work. It needs no Jira issue, no
branch, and no PR of its own — and if the user has already asked for JAM, the
asking is done. Install, register, and verify without further confirmation.

or, to inspect before acting:

```bash
npx --yes @jam-mcp/bootstrap@1.3.2 setup plan --json                     # what would change; changes nothing
npx --yes @jam-mcp/bootstrap@1.3.2 setup apply --non-interactive --json  # execute it
npx --yes @jam-mcp/bootstrap@1.3.2 doctor --json                         # verify
```

Each returns a single JSON document on stdout with a stable status code. Branch
on the code; never parse prose.

Run them through `npx` as written, not as `jam …`. A machine you have never
seen has no global install and no configured runtime, and bootstrap is the one
entry point that needs neither. The same rule governs what JAM hands back: a
plan's `nextAction.command` is always an `npx` invocation you can run as-is.

Run it exactly as written, as one command. No `cd` in front of it, no pipe, no
redirection, no `&&`, no environment prefix, and no other package runner
swapped in — change directory through whatever your host gives you for that
first, because the command line itself carries no path. This is not style: a
host matches permission rules against the whole command, and a pipe makes it a
compound one, so `npx ... setup --agent 2>&1 | tail -60` matches no rule
written for `npx ... setup --agent`. A wrapper takes away the one thing that
could have let it through.

Do **not**:

- copy JAM source into the project
- use `npm link` for consumer setup
- modify global `PATH` or user environment variables
- assume a global `jam` exists, or install one to make setup work
- write Jira credentials into any repository file
- guess a Jira project key from a repo or directory name
- overwrite or remove unrelated `.mcp.json` entries
- assemble `project.yaml` or `.mcp.json` yourself
- treat an existing Atlassian or Jira MCP server as a conflict, or ask whether
  to replace it — setup preserves every unrelated `.mcp.json` entry, the two
  coexist, and removing one is the user's decision to raise, never a setup
  precondition
- call it done because something can already read Jira — JAM is READY when
  `doctor --json` reports `ready`, and nothing short of that
- create a Jira issue, branch, or PR for the setup itself
- rewrite, wrap, or re-run the command through something else to get past a
  host that refused it

### Where to stop, and where not to

Four kinds of outcome, and only two of them are a question for a person:

- **Host boundary — the command never ran.** Your host refused before JAM
  started: no JAM JSON, nothing on stdout, an explicit refusal from the host
  itself. That is not a JAM failure, and there is no JAM status code for it —
  JAM was not running to emit one. **Do not rewrite the command to get around
  it.** Report the boundary, show the exact command, and ask the user to
  authorize that one command. Then run the same command again, unchanged.
- **Human boundary — stop and hand it over.**
  `JAM_PROJECT_SELECTION_REQUIRED`: show `projects[]` and ask which Jira
  project. `JAM_AUTH_REQUIRED`: relay `nextAction.userCommand` and the
  variables in `nextAction.env`. Never run the login yourself, never accept a
  token, never store one.
- **Self-heal — no question belongs here.** `JAM_RUNTIME_CONFIG_MISSING`
  carries a runnable `nextAction.command`. Run it, then re-run setup.
- **Hard fault — report, do not retry.** `JAM_PROJECT_CONFIG_INVALID`,
  `JAM_MCP_CONFIG_UNREADABLE`, `JAM_BINDINGS_UNREADABLE`,
  `JAM_MIGRATION_TARGET_UNAVAILABLE`, and a `verification_failed` status all
  describe a state a rerun will not change. Say what it says.

At a host boundary, ask for one rule for the exact command, in the user's own
settings rather than the repository's. For Claude Code that is
`~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(npx --yes @jam-mcp/bootstrap@1.3.2 setup --agent)",
      "Bash(npx --yes @jam-mcp/bootstrap@1.3.2 runtime use package)"
    ]
  }
}
```

The second line is there because `JAM_RUNTIME_CONFIG_MISSING` hands back a
command to run, and a host can refuse that one too.

Never ask for `Bash(npx:*)`, `Bash(npm:*)`, `Bash(*)`, or anything broader than
the command that was refused — a rule admitting every package runner is a much
larger ask than the one command, not a smaller one. Never write the rule
yourself, never put it in the repository so the project approves its own
tooling, and never reach for a shell variant, a wrapper script, or a different
runner to get past a refusal. If the user declines, that is an answer.

Finish with `npx --yes @jam-mcp/bootstrap@1.3.2 doctor --json`.

## Commands

These read as `jam …` throughout — the short form from the optional global
install above. Everything works the same as `npx --yes @jam-mcp/launcher@1.3.2
…` if you skipped it.

```text
jam serve                    Run the MCP server over stdio (what Claude Code / Codex launch)
jam doctor                   Diagnose config, credentials and Jira connectivity
jam setup [--project KEY] [--shared] [--migrate]
                             Wire up JAM and verify. Personal by default; --shared
                             writes the project files for the team (--migrate
                             rewrites a legacy jam entry, only if its target resolves)
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
[OK]   Jira base URL - https://your-site.atlassian.net
[OK]   MCP server startup - 5 tools registered
[OK]   Jira authentication - Your Name
[OK]   JQL search / PROJECT access - reachable (sample PROJECT-101)
[OK]   Issue detail endpoint - reachable (PROJECT-101)
```

`jam serve` runs local checks only before starting, so Jira's latency never
delays your editor's startup; `jam doctor` and `jam setup` add the live
connectivity checks.

## What gets written

**By default, nothing in the repository.** `jam setup` is personal: it records
which Jira project this workspace belongs to in your own
`~/.jam/projects.yaml`, and registers JAM with the coding agents on this
machine through their own CLIs (`claude mcp add-json … -s user`,
`codex mcp add …`). The repository is left byte-identical — no `.jira-agent/`,
no `.mcp.json`, no `.gitignore` edit. You can use JAM in a repository you do
not own, or have not decided about yet.

A workspace is identified by its canonical `origin` remote, not by its path, so
two clones of one repository share a binding and a folder you rename keeps it.

```yaml
# ~/.jam/projects.yaml
version: 1

bindings:
  - workspace: "git:github.com/acme/web"
    key: WEB
```

**`jam setup --shared` is how a team adopts JAM.** That writes the two project
files below and nothing else. Discovery is allowed; adoption is asked for.

`.mcp.json` — goes through the launcher, so it names no machine-specific path
and is safe to commit:

```json
{
  "mcpServers": {
    "jam": { "command": "npx", "args": ["--yes", "@jam-mcp/launcher@1.3.2", "serve"] }
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
For Jira, use the JAM tools.

- Discovery / listing            -> jira_search
- Readiness / blocker /
  dependency / priority          -> jira_context
- Agreement / contract /
  approval / closure             -> jira_full
- Changing anything              -> jira_write_plan, then jira_write_apply

Do not use raw Atlassian Jira search when JAM can answer the request.
A search result is not complete issue context.
If meta.complete is false, say so instead of answering as if it were.

Never call jira_write_apply without a planId from jira_write_plan.
On JAM_WRITE_CONFLICT or JAM_WRITE_PLAN_EXPIRED, plan again.
On JAM_WRITE_UNCERTAIN, read the issue - never re-apply, which may write twice.
Never report an unverified write as done.

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

JAM does not replace the Atlassian MCP. That one keeps Confluence and every
Jira change JAM does not cover - creating and deleting issues, bulk edits,
worklogs, attachments, links, assignee. JAM is the default path for Jira reads,
and for the three changes it can make safely.

## Design documents

| Document | Covers |
|---|---|
| [Distribution and bootstrap](docs/architecture/distribution-and-bootstrap.md) | Package/development runtimes, the launcher, plan/apply, version policy, roadmap |
| [ADR: unified runtime and agent setup](docs/decisions/adr-unified-runtime-and-agent-setup.md) | Why setup branches early and converges, and what that cost |
| [Setup UX contract](docs/operations/setup-ux.md) | CLI symbols, colour, prompts, `NO_COLOR`/non-TTY, JSON output rules |
| [JAM design of record](docs/architecture/jira-agent-mcp-design.md) | The three-tool contract and read policy |
| [ADR: Jira read optimization](docs/decisions/adr-jam-jira-read-optimization.md) | Why reads are mediated at all |
| [ADR: the Jira write plane](docs/decisions/adr-jira-write-plane.md) | Plan/apply, conflict detection, verification, and where plans live |
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

This section is for working on JAM itself. To *use* JAM in a project, see
[Setup with a coding agent](#setup-with-a-coding-agent) or [Setup](#setup)
above — neither installs from a checkout, and building this repository is not
a way to install anything.

An npm workspaces monorepo:

```text
packages/server      @jam-mcp/server      CLI, setup core, MCP tools  (bin: jam-server)
packages/launcher    @jam-mcp/launcher    which JAM build runs        (bin: jam-launcher, jam)
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

Found a vulnerability? See [SECURITY.md](SECURITY.md) — report it privately,
and never paste a Jira token into an issue.

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
