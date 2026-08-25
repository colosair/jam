# ADR: Unified runtime resolution and agent-installable setup

- **Status:** Accepted
- **Supersedes:** nothing
- **Implements:** [Distribution and bootstrap](../architecture/distribution-and-bootstrap.md)
- **Related:** [ADR: Agent-oriented Jira read optimization](adr-jam-jira-read-optimization.md)

## Context

JAM read well and installed badly.

Getting it working meant cloning the repo, `npm ci`, `npm run build`,
`npm link`, checking `where jam`, discovering the npm global bin was not on
PATH, and hand-writing an `.mcp.json` containing an absolute path to one
machine's checkout. Every one of those steps is a place to fail, and the
resulting config file only worked on the machine that produced it — the
opposite of something a team commits.

Three pressures made this urgent rather than cosmetic:

- **Teammates should not need the repo.** Someone who only *uses* JAM was being
  asked to clone and build a TypeScript project.
- **Contributors still need a local checkout.** Whatever consumers get must not
  remove the ability to run JAM from source and debug it.
- **Agents are now a real installer.** "Here is JAM, set it up in this project"
  is a reasonable request to make of Claude Code or Codex. Left to a README, an
  agent invents a plausible installation procedure — `npm link`, PATH edits,
  hand-assembled JSON, a guessed Jira project key — and each invention is a
  different way to get it subtly wrong.

The temptation in all three cases is a separate path: a consumer installer, a
contributor installer, an agent installer. That is how a system acquires three
implementations of the same decisions and two of them rot.

## Decision

**Branch at distribution and runtime resolution only. Converge on a single
Bootstrap Core and a single JAM Core immediately afterwards.**

Concretely:

**Three packages, lockstep, exact pins.** `@jam-mcp/server` (CLI, setup core,
MCP tools), `@jam-mcp/launcher` (which build runs, nothing else),
`@jam-mcp/bootstrap` (zero-install first run). Dependencies flow
bootstrap → server → launcher, all at exact versions.

**A project declares use, not location.** `.mcp.json` names the launcher at an
exact version; the launcher consults the user's own `~/.jam/config.yaml` to
decide whether that means the published package or a local checkout.

**One setup core, two front ends.** `detect → plan → apply → verify`. The wizard
and the agent API differ in presentation and in the ability to ask a question —
never in what setup decides or what it is permitted to touch.

**Plan is pure; apply is obedient.** Planning reads state and returns a change
list without writing anything. Applying executes exactly that list.

**Structured status codes, not prose.** `JAM_PROJECT_SELECTION_REQUIRED`,
`JAM_AUTH_REQUIRED`, and the rest, so a caller branches on a code rather than
pattern-matching an error message.

**Safe Bootstrap applies to automation without exception.** An agent gets the
same refusal to guess a Jira project key that a person does.

## Why these, and not the obvious alternatives

### Why branch early instead of everywhere

The alternative — a consumer path and a contributor path all the way down —
means every future change to project wiring, health checking or credential
resolution must be made twice and kept identical. The differences that actually
exist between the two cases are exhausted by the time you have answered "which
executable do I run". Below that line, package and development mode want
byte-identical behaviour, and the cheapest way to guarantee that is to have
only one implementation.

The same argument holds for human vs. agent. The genuine difference is whether
a question can be asked. That is a property of the front end, not of setup.

### Why the launcher is a separate package

It could have been a mode of the server. Making it separate buys one thing:
`.mcp.json` can name it at a stable exact version while the server underneath
changes independently. The cost is a third package to release; the benefit is
that the file a team commits does not have to be rewritten every time the
server version moves.

It stays deliberately tiny — no Jira, no credentials, no setup mutation — so
that "which build runs" cannot accumulate opinions about anything else.

### Why plan/apply rather than just doing it

An agent that cannot see what a command will do before running it has two
options: refuse, or trust. Neither is good when the command writes to a repo.
Separating the decision from the mutation makes the preview real rather than a
description of intent, and the same split gives humans a `--migrate` flag that
is genuinely opt-in — the plan simply does not contain the change unless asked.

It also removes a category of bug. When deciding and writing are interleaved,
"what will change" and "what changed" are two code paths that can disagree.

### Why exact pins and no major alias

A `@1` alias or `@latest` means a teammate's editor can start launching
different code than it did yesterday, with no diff to point at. For something
that runs automatically when an editor opens, that is the wrong default. The
cost is a `.mcp.json` edit per JAM upgrade — visible, reviewable, and
deliberate.

### Why the agent must not assemble config itself

An agent generating `project.yaml` and `.mcp.json` directly would be a fourth
implementation of setup, with no access to the merge rules that preserve other
MCP servers or the refusal rules that prevent guessing. Routing it through
`setup plan` / `setup apply` means every safety property JAM enforces is
enforced for agents by construction rather than by instructions in a README
that an agent may or may not follow.

### Why authentication is the one human boundary

Everything else in setup is a decision JAM can make correctly from the state of
the machine. Credentials are not: they are a secret the user holds, and an
agent that asks for one, stores one, or writes one into a repo has done
something wrong regardless of intent. So `JAM_AUTH_REQUIRED` is a stop with a
structured next action, and `auth status` returns presence and origin but never
a value.

## Consequences

### Gained

- A consumer needs Node, Jira access, and one command. No clone, no build, no
  `npm link`, no PATH surgery.
- `.mcp.json` is genuinely shareable — nothing machine-specific in it.
- Contributors keep a first-class local-source workflow, switchable per machine
  without touching any project.
- Agents have an official, safe installation path, so they stop inventing one.
- The safety properties (preserve other MCP servers, never guess a key, never
  write credentials, never touch PATH or user environment) hold for every entry
  point, because there is only one implementation of each.

### Given up

- **Three packages to release instead of one.** Lockstep versioning keeps this
  manageable but it is real overhead, and a partial publish would be worse than
  none.
- **A network dependency on first run.** Package mode downloads through npx.
  Development mode does not, which is the fallback when that matters.
- **An extra process in the chain.** The launcher spawns the server, so there
  is one more place a failure can occur — mitigated by distinct error codes and
  by full stdio/exit/signal forwarding, but not eliminated.
- **Upgrades are manual.** Exact pins mean nothing moves until someone edits a
  file. That is the point, and it is still a cost.
- **A larger surface to keep honest.** The JSON contract, the status codes and
  the plan/apply parity are now things that can break silently, so they are
  covered by tests rather than by convention.

### Explicitly not decided here

Credential storage beyond the current environment-and-registry resolution
(D9), whether `serve` should start without credentials and fail per-tool
(D10), project-declared runtime versions (D11), and standalone binaries (D12)
are all deferred with their reasons recorded in the architecture document.

**Nothing is published.** The packages build, pack, and pass isolated tarball
smoke, but the registry paths are unexercised until publication. The evidence
that these package boundaries work is the smoke harness, not an install.

## Related

- [Distribution and bootstrap](../architecture/distribution-and-bootstrap.md) — the structure this decides on
- [Setup UX contract](../operations/setup-ux.md) — how it presents itself
- [Architecture backlog](../architecture/backlog.md) — deferred items
