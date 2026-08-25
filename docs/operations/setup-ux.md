# Setup UX contract

What `jam setup`, `jam runtime` and `jam doctor` are allowed to put on a
terminal, and what they must emit when there is no terminal at all.

The standard this is written to:

> JAM's CLI is a developer's install and diagnostic tool, not a terminal app.
> Its job is to make the current state and the next action obvious immediately.

That rules out most of what makes a CLI look impressive, and it is the reason
for nearly every rule below.

## Symbols

| Symbol | Means |
|---|---|
| `◆` | Section / current stage |
| `✓` | Success |
| `!` | Warning |
| `×` | Failure |
| `❯` | Selected item |
| `○` | Pending |
| `›` | Next action |

Meaning is never carried by colour alone. Every state has a distinct symbol, so
the output reads correctly with colour stripped, in a log file, or by someone
who cannot distinguish the colours. A test enforces this.

No emoji. No large ASCII logo. No nested boxes, gradients or rainbow output.

## Colour

| Role | Colour |
|---|---|
| Accent, current selection | cyan |
| Success | green |
| Warning | yellow |
| Failure | red |
| Secondary detail | dim |
| Everything else | terminal default |

Colour is disabled when any of these hold:

- `NO_COLOR` is set — **including when it is empty**, per the convention
- `CI` is set
- stdout is not a TTY

## Layout

A first run:

```text
◆ JAM
  Jira Agent MCP

  Configure JAM for this machine.

◆ Runtime

How will you use JAM?

❯ Use JAM
  Run the project-pinned package. Recommended for most users.

  Develop JAM
  Run a local source checkout.
```

Then, per stage:

```text
◆ Runtime
✓ Runtime configured     package · 1.0.0

◆ Authentication
✓ Jira credentials found user@example.com · https://example.atlassian.net (process)

◆ Project
✓ Project configured     PROJECT · from explicit

◆ Verify
✓ Node runtime           v20.11.0
✓ Jira authentication    Your Name
✓ MCP server             3 tools registered

✓ JAM ready

› Start Claude Code or Codex and use JAM.
```

**Sections, not `[2/5]` counters.** A fixed counter lies the moment a step turns
out to be already done and gets skipped — and skipping is the common case on
every run after the first.

## Asking

**Do not ask what can be determined.** If credentials resolve, say so and move
on:

```text
✓ Jira credentials found user@example.com · https://example.atlassian.net (process)
```

A `Use these credentials? [Y/n]` prompt here is a question with one sensible
answer, and it trains people to press Enter without reading.

The same applies to an existing project config, an already-chosen runtime, and
an `.mcp.json` that already has a jam entry — each is reported, not re-asked.

**Runtime choices are worded behaviourally.** "Use JAM" and "Develop JAM", not
"Package runtime" and "Development runtime". Package and development are JAM's
internal vocabulary; what a user knows is whether they are using it or working
on it. Default is Use JAM.

**Cancellation is safe and says so.** Esc and Ctrl-C exit with a message
confirming nothing was changed.

## Re-running

Setup is a state manager, not a one-shot script. When everything is already in
place it shows status and offers actions rather than replaying the wizard:

```text
◆ JAM

✓ Runtime                package · 1.0.0
✓ Authentication         configured · user-env
✓ Project                PROJECT
✓ MCP                    ready

Everything is configured.

What do you want to do?

❯ Run health check
  Change runtime
  Re-authenticate
  Repair project setup
  Exit
```

## Spinners

Allowed only for genuine waiting:

- Jira authentication
- Remote project listing
- Package download
- Remote health checks

Not allowed for: reading a config file, checking whether a path exists, parsing
a version, merging `.mcp.json`. Spinning through instant local work makes fast
operations feel slow and trains people to distrust the indicator.

Also not allowed around synchronous work, however slow. The migration target
probe blocks the process, so a spinner would print one frame and then freeze —
it gets a pending line instead, and only when a probe actually happens:

```text
○ Checking @jam-mcp/launcher@1.0.0 on npm...
```

Disabled entirely when not interactive, where it degrades to a single pending
line.

## Warnings and failures

No boxes. State the problem, then the comparison or the action:

```text
! Local JAM version differs from the project requirement.

  Project  1.0.0
  Local    1.1.0-dev
```

```text
× Jira authentication failed

  The stored credentials were rejected.

› Re-authenticate
```

```text
× Migration target is not available from the configured npm registry

  npm could not find @jam-mcp/launcher@1.0.0 in the configured registry.
  Existing .mcp.json was left unchanged.
```

## Non-TTY, CI and `NO_COLOR`

All three disable colour, spinners and prompts.

A question that genuinely cannot be answered is an **error naming the flag that
answers it**, never a silently chosen default:

```text
× How will you use JAM? cannot be asked without a terminal.

› Run:  jam runtime use package
```

This is its own error type internally, so it is reported as guidance rather
than diagnosed as a JAM or Jira fault — an early version surfaced it as
`JIRA_UNAVAILABLE`, which blamed Jira for the absence of a terminal.

Plain output in these modes stays line-oriented and greppable:

```text
JAM setup
Runtime: package
Credentials: configured
Project: PROJECT
Result: ready
```

## Machine output

For agents and scripts:

```bash
jam setup plan --json
jam setup apply --non-interactive --json
jam setup --agent
jam doctor --json
jam runtime --json
jam auth status --json
```

The contract:

- **stdout is one parseable JSON document and nothing else.** Not "JSON plus a
  banner", not "JSON somewhere in the output". Tests parse the whole of stdout.
- No ANSI escapes anywhere in it.
- No prompts, ever — these paths are non-interactive by construction.
- Diagnostics go to stderr.
- Status codes are stable and branchable; callers must never have to
  pattern-match prose.
- Credentials never appear. `auth status` reports presence and origin only.

Human-facing colour output and the machine interface are separate paths. Adding
a decorative line to the JSON path is a breaking change.

## Related

- [Distribution and bootstrap](../architecture/distribution-and-bootstrap.md)
- [ADR: unified runtime and agent setup](../decisions/adr-unified-runtime-and-agent-setup.md)
