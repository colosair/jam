# JAM (Jira Agent MCP)

## Jira reads

Use the JAM tools for Jira. Pick by what the answer will be used for:

- Discovery / listing / current status → `jira_search`
- Readiness / blocker / dependency / priority → `jira_context`
- Agreement / contract / approval / closure → `jira_full`

To change an issue, see [Jira writes](#jira-writes) below - never a raw
Atlassian write when JAM covers the operation.

Do not use raw Atlassian Jira search when JAM can answer the request. A
`jira_search` result is not complete issue context — never conclude from it that
something is agreed, approved, unblocked, or done.

Every result carries a `meta` block. If `meta.complete` is `false`, report the
answer as partial rather than answering as if it were whole.

`meta.complete` is about retrieval, not about the project. It means JAM
finished the Jira read with no known loss — never that Jira holds the whole
story. `meta.evidenceScope` and `meta.limitations` say what was not evaluated:
the repository, external sources, and any dependency that lives outside Jira.
So `links: []` with `linksComplete: true` means Jira holds no visible link,
not that nothing blocks the work, and `blocksThisIssue` reports how Jira words
a link rather than whether work can start.

## Jira writes

Changing a Jira issue is two calls, always in this order:

```text
jira_write_plan   -> read the issue, check the change is possible, get a planId
jira_write_apply  -> pass that planId; JAM writes, then reads the issue back
```

`jira_write_apply` takes a `planId` and nothing else. There is no payload to
pass and no way to skip the plan - if you find yourself wanting one, the answer
is a new `jira_write_plan`, not a different call.

Show the user what the plan says before applying it. The plan's `before` and
`intendedAfter` are the whole point of the split: they are what makes the change
reviewable while it is still cheap to abandon.

Three operations, and nothing else is writable: `comment.add` (plain text),
`field.update` (summary, priority, labels, components), `status.transition`.
Writes are confined to the configured Jira project.

Handle these failures as follows, and do not collapse them into "it failed":

- `JAM_WRITE_CONFLICT`, `JAM_WRITE_PLAN_EXPIRED` - the issue moved or the plan
  aged out. Plan again against the current state; do not retry the apply.
- `JAM_WRITE_VERIFICATION_FAILED` - Jira accepted the change but the issue does
  not show it. Read the issue and tell the user what it actually says.
- `JAM_WRITE_UNCERTAIN` - JAM does not know whether the write landed. **Read the
  issue. Never call `jira_write_apply` again** - the write may already have been
  applied, and a second attempt is a second comment or a second transition.

Only an `applied` receipt means it happened. An unverified or uncertain write is
never reported to the user as done.

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

## Installing JAM into another project

If asked to set JAM up somewhere, use the official setup path — do not work out
an installation procedure from the README. One command does the whole thing:

```bash
npx --yes @jam-mcp/bootstrap@1.2.0 setup --agent
```

To inspect before acting, the same three steps separately:

```bash
npx --yes @jam-mcp/bootstrap@1.2.0 setup plan --json                     # what would change; changes nothing
npx --yes @jam-mcp/bootstrap@1.2.0 setup apply --non-interactive --json  # execute it
npx --yes @jam-mcp/bootstrap@1.2.0 doctor --json                         # verify
```

Run them through `npx` exactly as written. A bare `jam` is a convenience some
people install and most machines do not have, and the launcher cannot stand in
for it before a runtime is configured — bootstrap is the only entry point that
needs neither. This holds for what JAM hands back too: a plan's
`nextAction.command` is already an `npx` invocation, so run it as given rather
than shortening it.

These are personal by default: they record the binding in the user's
`~/.jam/projects.yaml` and register JAM with this machine's coding agents,
leaving the repository byte-identical. Add `--shared` only when the user has
asked to adopt JAM for the team — that is what writes `.jira-agent/project.yaml`
and `.mcp.json` into the repository. Never add it on your own initiative.

Each returns a single JSON document with a stable status code — branch on the
code, never on prose.

Never: copy JAM source into the project, `npm link` for consumer setup, modify
`PATH` or user environment variables, write credentials into a repository file,
guess a Jira project key, overwrite unrelated `.mcp.json` entries, assemble
`project.yaml` / `.mcp.json` / `~/.jam/projects.yaml` by hand, edit a host's own
MCP config file, or pass `--shared` without being asked to.

Stop only for `JAM_PROJECT_SELECTION_REQUIRED` (ask which Jira project) and
`JAM_AUTH_REQUIRED` (tell the user to authenticate themselves). Finish with
`npx --yes @jam-mcp/bootstrap@1.2.0 doctor --json`.

Authentication is the one step that is not yours to do. Never ask for an API
token, never accept one that is offered, never store one, and never run the
login on someone's behalf - it is interactive and human-only by design.
Report `JAM_AUTH_REQUIRED` and stop.

## This repo

TypeScript, ESM, Node 20+. npm workspaces monorepo: `packages/server`
(CLI, setup core, MCP tools), `packages/launcher` (which JAM build runs),
`packages/bootstrap` (zero-install entry). Inside the server, ports & adapters:
`src/domain` → `src/policy` → `src/ports` → `src/adapters`, with
`src/application` orchestrating, `src/bootstrap` holding detect/plan/apply, and
`src/mcp` exposing the tools.

- The external contract is exactly five tools - three read, two write. Adding
  or renaming one is a breaking change; internal refactors must not touch it.
- Writing is plan then apply. `jira_write_apply` takes a `planId` and no
  payload, and a write is not applied until a direct read confirms it. A write
  is never retried on an ambiguous failure.
- Raw Jira DTOs stop at `src/adapters/jira-cloud/mapper.ts`.
- Credentials never reach a log, telemetry line, or tool result.
- Silent truncation is a release blocker. Anything dropped must show up in
  `CompletenessMeta`.
- `stdout` belongs to the MCP protocol — diagnostics go to `stderr`.
- Setup decides in `setup-plan.ts` and writes in `setup-apply.ts`. Planning
  must never mutate; applying must never re-decide.
- Human and agent entry points share that core. No parallel implementation.
- Package versions are pinned exactly - no `@latest`, no major alias.

```bash
npm run build
npm test
node packages/server/dist/index.js doctor
```

Design of record: `docs/architecture/jira-agent-mcp-design.md` and
`docs/architecture/distribution-and-bootstrap.md`.
