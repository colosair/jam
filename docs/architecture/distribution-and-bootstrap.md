# Distribution and bootstrap

How JAM gets onto a machine, into a project, and started — for a person, for a
JAM contributor, and for a coding agent.

The governing rule:

> Branching is allowed at distribution and runtime resolution. Past that point
> everything converges on the same Bootstrap and the same JAM Core.

There is one setup core, one runtime resolver, one health gate, and one set of
three MCP tools. Human vs. agent and package vs. development are differences in
*entry*, never in *logic*.

## Shape

```text
                        Entry
                          │
            ┌─────────────┴─────────────┐
            │                           │
      Human interactive           Agent / automation
      (setup wizard)              (CLI flags, JSON)
            │                           │
            └─────────────┬─────────────┘
                          ▼
                    BootstrapPlan          ← decide, change nothing
                          ▼
                   RuntimeResolver
                          │
             ┌────────────┴────────────┐
             │                         │
      Package runtime          Development runtime
      (published npm)          (local checkout)
             │                         │
             └────────────┬────────────┘
                          ▼
                  BootstrapOrchestrator
                          ▼
          Credential · Project · MCP · Health gate
                          ▼
                       JAM Core
                          ▼
        jira_search   jira_context   jira_full
```

What must never appear: `PackageJamServer` / `DevelopmentJamServer`,
`AgentSetupService` / `HumanSetupService`, or any parallel pair of the same
logic. If two entry points need different behaviour, that difference belongs in
a plan, not in a duplicated implementation.

## Packages

Three, released lockstep at the same version.

| Package | Owns | Must not contain |
|---|---|---|
| `@jam-mcp/server` | JAM CLI, bootstrap core, Jira ports/adapters, application, domain, policy, MCP server and the three tools. `bin: jam` | — |
| `@jam-mcp/launcher` | Runtime config, resolver, package/development runtimes, child dispatch with cwd/stdio/exit/signal forwarding. `bin: jam-launcher` | Jira API calls, credential logic, setup mutation, MCP tools |
| `@jam-mcp/bootstrap` | Zero-install entry for first run, human and agent. `bin: jam-bootstrap` | Any setup logic of its own — it forwards to the server |

Dependency direction, all exact:

```text
@jam-mcp/bootstrap  →  @jam-mcp/server  →  @jam-mcp/launcher
```

The launcher is deliberately the smallest thing in the system. It answers one
question — *which JAM build runs here* — and knows nothing about Jira.

## Runtime resolution

A user picks once, on their machine, in `~/.jam/config.yaml`:

```yaml
version: 1
runtime:
  mode: package
```

```yaml
version: 1
runtime:
  mode: development
  source: C:\projects\jam
```

- **Package** resolves to `npx --yes @jam-mcp/server@<exact>`. The version comes
  from a constant in the launcher, since the three packages ship lockstep.
- **Development** resolves to `node <source>/packages/server/dist/index.js`,
  after validating that the path exists, is a JAM checkout, contains
  `@jam-mcp/server`, and has been built. Validating up front is what turns a
  stale path into a clear message instead of a module-not-found from deep
  inside node.

Switching is `jam runtime use package` or `jam runtime use development <path>`.
Neither touches a project.

## The launcher contract

`.mcp.json` in a project says only that the project uses JAM:

```json
{
  "mcpServers": {
    "jam": { "command": "npx", "args": ["--yes", "@jam-mcp/launcher@1.0.0", "serve"] }
  }
}
```

The project therefore does not know — and must not need to know — whether a
given teammate is on the package or a local checkout, where their checkout
lives, or where their credentials come from.

Two hard rules in dispatch:

- **stdout belongs to the MCP protocol** and is handed to the child untouched.
  Every launcher diagnostic goes to stderr, including `--help`.
- Exit codes propagate; `SIGINT`/`SIGTERM`/`SIGHUP` are forwarded to the child;
  a signalled death is reported as `128 + signal` rather than as success.

Launcher failures are distinguishable rather than generic:

| Code | Means |
|---|---|
| `JAM_RUNTIME_CONFIG_MISSING` | Not set up yet — run bootstrap `init` |
| `JAM_DEVELOPMENT_SOURCE_INVALID` | Set up, but the checkout is wrong or unbuilt |
| `JAM_PACKAGE_RUNTIME_FAILED` | Set up correctly, but the runtime would not start |

## Setup: detect → plan → apply → verify

```text
detect   read-only snapshot: runtime, credentials, project, .mcp.json
plan     pure function; returns a change list, mutates nothing
apply    executes exactly the listed changes, nothing more
verify   the shared health gate
```

`plan` being pure is what makes a preview trustworthy and what lets an agent
reason before acting. `apply` re-decides nothing — if a change is not in the
plan, it does not happen.

Where a decision needs a fact about the world, the caller observes it and hands
it to `plan` — `jamEntryIsLegacy` and the migration preflight both arrive that
way. The planner never reaches for the network, a subprocess, or a clock, which
is what keeps the purity above literally true rather than aspirational.

### Status codes

| Code | Meaning |
|---|---|
| `JAM_PROJECT_SELECTION_REQUIRED` | No key could be decided safely; a list of visible projects is offered |
| `JAM_AUTH_REQUIRED` | Wiring can proceed, but a person must authenticate |
| `JAM_RUNTIME_CONFIG_MISSING` | No runtime chosen on this machine yet |
| `JAM_PROJECT_CONFIG_INVALID` | `project.yaml` exists but will not parse — refuse, do not overwrite |
| `JAM_MCP_CONFIG_UNREADABLE` | `.mcp.json` is not valid JSON — refuse, do not overwrite |
| `JAM_MIGRATION_TARGET_UNAVAILABLE` | `--migrate` was asked for, but the launcher package could not be resolved — `.mcp.json` left unchanged |

### Where credentials come from

```text
process environment  →  this user's OS secret store  →  Windows User environment
```

The environment stays first, so a per-session override still wins and CI keeps
working unchanged. The secret store comes next because it is the only source an
editor launched from a Dock or Start menu can reach — such a process never
sourced a shell profile, so it has no `JIRA_*` to inherit and the MCP child it
spawns has none either. `jam auth login` writes it; `jam auth status` reports
presence and origin, never the value.

Merging is per field, so one stale `export` can shadow part of a stored
credential; that shows up as `source: mixed`, and `auth login` and `auth logout`
both say so rather than leaving the user to work it out.

| Platform | Backend |
|---|---|
| macOS | login Keychain, via `security` |
| Linux | libsecret, via `secret-tool` |
| Windows | a file under `~/.jam` encrypted to the current user with DPAPI |

Windows uses DPAPI because Credential Manager cannot be read back without a
P/Invoke or a module that is not installed by default. **The confidentiality
boundary there is DPAPI's current-user binding**; the `0o600` mode on the file
is best-effort hardening on top, and carries no POSIX guarantee on Windows.

Being on a platform is not the same as having a store. A container or a headless
Linux box routinely has neither libsecret nor a session keyring, so the backend
is probed rather than assumed, and `jam auth login` says which of "absent" and
"switched off for a sandbox" it hit.

On macOS the token reaches `security` as an argument rather than on stdin,
because `security` reads its own `-w` prompt from the controlling terminal. It
is collected only through a masked prompt, never written to a repo, config file
or shell history, and the child that carries it lives for one call. Replacing
that needs a native API or OAuth, which D9 deliberately does not add.

`JAM_PROJECT_CONFIG_INVALID` and `JAM_MCP_CONFIG_UNREADABLE` are stops rather
than failures: they hold the user's own settings, so "fixing" them by
overwriting would destroy the thing that needs fixing.

`JAM_MIGRATION_TARGET_UNAVAILABLE` is that same instinct pointed forward. A
migration rewrites wiring the user already has working, so it only happens once
the destination is known to resolve — `npm view` against their own npm
configuration, so a privately published launcher answers correctly. Anything
that cannot be verified — offline, blocked proxy, no npm, timeout — refuses the
rewrite, because every one of those would also break `npx --yes <spec> serve` at
launch time. The probe is gated on a pending replacement, not on the flag, so
setup never reaches the registry on a path that rewrites nothing. The rest of
the plan still applies: declining the rewrite is no reason to leave a project
unwired.

### Safe Bootstrap

A Jira project key comes from an explicit source or not at all:

```text
existing project.yaml  →  --project KEY  →  JAM_PROJECT_KEY  →  exact preset match
                                                             →  otherwise: selection required
```

JAM never infers a key from a repository name, a directory name, or similarity
to a Jira project's title. This holds identically for agents — automation gets
the same refusal a person does, plus the project list so its user can choose.

## Project-shared vs. user-local

| Shared, committed | Local to a user, never committed |
|---|---|
| `.mcp.json` (launcher entry) | Runtime mode and development source path |
| `.jira-agent/project.yaml` (project key, field policy) | Jira credentials |
| Required JAM version *(planned, D11)* | OS secret-store state, npm cache |

Consequences that follow directly:

- No credential is ever written into a project file.
- No absolute path from one machine is ever written into a project file.
- Switching runtime never modifies a project; wiring a project never modifies
  runtime choice.
- A team never shares one Jira service account — JAM shares policy, not
  permissions.

## Three independent versions

```text
Launcher protocol   @jam-mcp/launcher@<version> in .mcp.json
JAM runtime         which server build actually runs
Project schema      version: 1 in project.yaml
```

They are separate because they change for different reasons. Today all three
packages release lockstep at the same version and the runtime version comes
from a launcher constant; when projects gain a required-version field, that
constant becomes the default it overrides.

Exact pins everywhere. No `@latest`, no `@1` major alias — a floating tag
would silently change what a teammate's editor launches.

## Agent entry points

```bash
jam setup --agent                          # one shot: detect, plan, apply safe, verify
jam setup plan --json                      # what would change, changing nothing
jam setup apply --non-interactive --json   # execute
jam doctor --json
jam auth status --json                     # presence and origin, never the value
```

Contract: **stdout is a single parseable JSON document**, no ANSI, no prompts;
stderr carries diagnostics. Enforced by tests that parse the whole of stdout
rather than extracting a JSON-looking part of it.

`setup --agent` applies whatever is safely applicable even when a human step
remains, and reports how far it got via `changesApplied`. A missing credential
should leave a project wired and waiting, not half-wired — and the caller needs
to know which happened.

Authentication is always a human boundary. Project selection is also a human
boundary whenever no canonical binding exists - JAM will list the projects it
can see and stop, because guessing which one a repository belongs to is a
decision, not a detection. Everything else an agent can complete on its own.

## Roadmap

| Phase | Status |
|---|---|
| D1 Runtime abstraction | done |
| D2 Bootstrap plan / mutation core | done |
| D3 Human interactive setup | done |
| D4 Agent setup API | done |
| D5 npm packaging (pack + isolated tarball smoke) | done |
| D6 Common launcher | done |
| D7 Project wiring and migration | done |
| D8 Documentation of record | done |
| D9 `jam auth login/status/logout`, OS secret store | implemented — macOS device verified; Linux and Windows injected-runner verified, device verification pending |
| D10 Degraded auth startup — serve connects, tools return `JAM_AUTH_REQUIRED` | planned |
| D11 Project-required `runtime.jamVersion` | planned |
| D12 Standalone binary | only on real demand |

**Not done: publishing to npm.** The packages build, pack and pass isolated
tarball smoke, but nothing is on the registry — so `npx @jam-mcp/...` paths
become real only after publication. Until then, development mode and a direct
node path are the working routes, which is why this repo's own `.mcp.json`
still points straight at `packages/server/dist/index.js`.

## Testing strategy

What each layer is actually held to:

- **Runtime** — config round-trip including Windows paths, malformed config
  treated as absent, exact-pin assertions, every development-source rejection,
  switching modes.
- **Plan / apply** — detect leaves the tree byte-identical, plan mutates nothing
  (recursive snapshot comparison), apply performs exactly the planned changes,
  a second pass plans and applies nothing, an existing key beats `--project`.
- **Agent JSON** — the whole of stdout parses, no ANSI, stable shape, stable
  status codes, no prompts without a TTY, plan/apply parity.
- **Launcher** — spawn arguments, cwd, `stdio: inherit`, exit code propagation,
  signal forwarding and handler cleanup, spawn failure mapping.
- **Mutation** — unrelated MCP servers preserved, an existing jam entry left
  alone, `--migrate` the only path that rewrites it, and only after its target
  is confirmed resolvable.
- **Security** — no credential written project-side, no development path
  written project-side, no PATH or user-environment mutation, no fuzzy project
  inference, no `@latest` in anything executable. Secret-store backends are
  exercised only through an injected runner, and the source that reads them
  takes its store as a required argument, so no test can reach a real keychain,
  libsecret session or DPAPI blob. The tarball sandbox switches the store off
  outright rather than relying on which backends happen to live under `HOME`.
- **MCP contract** — exactly three tools, unchanged.

Package paths are covered by `npm run pack:all` and `npm run smoke`, which
install the tarballs into sandboxes with their own `HOME`, cwd, npm cache and a
`JIRA_*`/`JAM_*`-stripped environment. The one thing that isolation cannot
reach is the Windows user environment in the registry, since JAM reads it on
purpose; the smoke checks assert on state the sandbox does control and say so
explicitly.

## Related

- [ADR: unified runtime and agent setup](../decisions/adr-unified-runtime-and-agent-setup.md)
- [Setup UX contract](../operations/setup-ux.md)
- [JAM design of record](jira-agent-mcp-design.md)
- [Architecture backlog](backlog.md)
