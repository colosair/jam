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

Six operations, and nothing else is writable: `comment.add` (plain text),
`field.update` (summary, priority, labels, components), `status.transition`,
`assignee.update`, `custom-field.update`, and `issue.create`. Writes are
confined to the configured Jira project.

`custom-field.update` takes `key` and `input.{field, value}`, and changes one
custom field. **A field being readable does not make it writable.** It has to
carry `writable: true` in `.jira-agent/project.yaml`; a whitelist written
before this release grants no writes. `field` is that entry's id or its name,
matched exactly. Failures to relay rather than retry:

- `JAM_WRITE_FIELD_NOT_ALLOWED` - the team never opted this field in.
  `details.writableCustomFields` lists the ones they did.
- `JAM_WRITE_CUSTOM_FIELD_NOT_EDITABLE` - Jira does not offer the field on this
  issue for this account, or does not offer `set` for it.
- `JAM_WRITE_CUSTOM_FIELD_TYPE_UNSUPPORTED` - JAM writes single-line text,
  number, single-select and multi-select. Dates, rich text, user and group
  pickers and app-owned fields are refused, not attempted.
- `JAM_WRITE_VALUE_NOT_ALLOWED` - wrong type for the field, or an option Jira
  does not offer. Types are never converted: `"5"` is not `5`.
- `JAM_WRITE_SCHEMA_CHANGED` - the field's configuration moved between plan and
  apply. **Nothing was written.** Plan again.

Not in this version: clearing a field, more than one field per plan, and
custom fields during `issue.create`.

`assignee.update` takes `key` and `input.assignee` - a display name, or an
accountId. **Never assume JAM will pick from a partial match.** It searches
Jira's directory and assigns only on an exact display name (case-insensitive)
or an exact accountId, because Jira's user search is a substring match and one
row is a similarity, not an identification. Failures to relay rather than
retry:

- `JAM_WRITE_ASSIGNEE_NOT_FOUND` - nobody matches exactly. `details.candidates`
  carries who Jira did find; show them and ask which one, or pass an accountId.
- `JAM_WRITE_ASSIGNEE_AMBIGUOUS` - two people share that display name. The
  candidates come back with their accountIds; one of those is the answer.
- `JAM_WRITE_ASSIGNEE_NOT_ASSIGNABLE` - the account is deactivated, or Jira
  does not offer them as an assignee for this issue. Not something to retry.
- `JAM_WRITE_ASSIGNEE_ALREADY_SET` - they already hold it. Nothing to do.

Not in this version: unassigning, setting an assignee while creating, and
reporter. `field.update` still refuses `assignee` - assignment goes through
`assignee.update` only.

`issue.create` has no `key` - there is no issue yet - and takes no project
either: the new issue goes into the project this workspace is bound to. It
accepts `issueType` and `summary` (both required), plus `description` (plain
text), `priority`, `labels` and `components`. Nothing else: no assignee, no
parent, no custom fields.

Planning a create reads Jira's create schema for that project first, so these
are JAM refusals rather than a Jira 400 arriving later:

- `JAM_WRITE_ISSUE_TYPE_NOT_AVAILABLE` - that type is not one this account can
  create here, or it is a subtask type, which needs a parent JAM does not set.
  The available types come back with the error.
- `JAM_WRITE_VALUE_NOT_ALLOWED` - the priority or component is not in the list
  Jira offers for this project and issue type. The allowed values come back too.
- `JAM_WRITE_REQUIRED_FIELD_UNSUPPORTED` - this project's create screen requires
  something JAM cannot set. Tell the user to create the issue in Jira; there is
  no input that gets past this.
- `JAM_WRITE_SCHEMA_CHANGED` - between plan and apply the create schema moved in
  a way that invalidates the plan. **Nothing was created.** Plan again.

Handle these failures as follows, and do not collapse them into "it failed":

- `JAM_WRITE_CONFLICT`, `JAM_WRITE_PLAN_EXPIRED` - the issue moved or the plan
  aged out. Plan again against the current state; do not retry the apply.
- `JAM_WRITE_VERIFICATION_FAILED` - Jira accepted the change but the issue does
  not show it. Read the issue and tell the user what it actually says.
- `JAM_WRITE_UNCERTAIN` - JAM does not know whether the write landed. **Read the
  issue. Never call `jira_write_apply` again** - the write may already have been
  applied, and a second attempt is a second comment, a second transition, or -
  for `issue.create` - a second issue. After an uncertain create, look in the
  project rather than planning another one.

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
npx --yes @jam-mcp/bootstrap@1.3.0 setup --agent
```

To inspect before acting, the same three steps separately:

```bash
npx --yes @jam-mcp/bootstrap@1.3.0 setup plan --json                     # what would change; changes nothing
npx --yes @jam-mcp/bootstrap@1.3.0 setup apply --non-interactive --json  # execute it
npx --yes @jam-mcp/bootstrap@1.3.0 doctor --json                         # verify
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
`npx --yes @jam-mcp/bootstrap@1.3.0 doctor --json`.

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
