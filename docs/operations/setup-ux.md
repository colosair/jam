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
  Run the published JAM release. Recommended for most users.

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
✓ MCP server             5 tools registered

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

**Cancellation is safe and says so.** Cancelling exits with a message
confirming nothing was changed. That holds for a half-typed token too.

Which key cancels follows who owns the line. A typed answer is edited by the
terminal's own line editor, so Esc belongs to it: Ctrl-C, Ctrl-D or a stdin
that ends cancel there. The token prompt and the choice list are JAM's own
readers, and Esc cancels those. JAM does not reimplement line editing to keep
one key consistent - an editor that mishandles Hangul, wide characters or an
arrow key costs more than the inconsistency does.

**Ask for what someone has, not for what the code wants.** `jam auth login` asks
you to *paste your Jira URL* — any page from your site — and takes the origin
itself. Nobody should have to know what an origin is, or delete a path by hand,
to log in. A URL that cannot be parsed is refused locally, before Jira is
contacted, and says to paste a page URL rather than naming a scheme.

**A mistyped answer costs that answer, not the command.** A URL that will not
parse, or a blank email, re-asks the step it belongs to - up to three times,
so a pipe that has stopped producing usable answers still ends. The email is
checked where it is asked, never after a token has been typed: asking for a
secret in order to reject the line before it wastes the one answer nobody
wants to repeat.

**Secrets are never echoed.** A token prompt prints nothing at all as you
type — no characters, no bullets, no length. Backspace and Delete work in every
form a terminal sends them, and every exit path restores raw mode and removes
the key listener, so nothing typed into one prompt can reach the next.

**Credentials are checked before they are stored.** `auth login` calls Jira
first; if Jira rejects them, nothing is written and it says so. Storing a
rejected token is the worst outcome available — every later command fails, and
the thing that is wrong looks like the thing that was just fixed.

**An override is reported, not silently obeyed.** If a `JIRA_*` variable shadows
what was just stored, `auth login` names the effective source. Merging is per
field, so it distinguishes shadowing *part* of a credential from shadowing all
of it. `auth logout` does the same in reverse: removing the stored copy is not
the same as being logged out, and it says which is true.

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
○ Checking @jam-mcp/launcher@1.4.5 on npm...
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

That last action is a real one: the status menu's **Re-authenticate** runs
`jam auth login`, it does not print instructions for exporting variables.

Without a terminal, `auth login` refuses rather than degrading - a token cannot
be asked for, and accepting one from a flag or a pipe would put it in argv and
shell history:

```text
× Paste your Jira URL cannot be asked without a terminal.

› Run:  set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN instead
```

```text
× Migration target is not available from the configured npm registry

  npm could not find @jam-mcp/launcher@1.4.5 in the configured registry.
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

## Scope

**Setup is personal until someone says otherwise.** `jam setup` records which
Jira project this workspace belongs to in the user's own
`~/.jam/projects.yaml`, registers JAM with the coding agents on this machine,
and leaves the repository byte-identical. Nothing about "try JAM on this repo"
should commit a decision on a team's behalf.

`jam setup --shared` is the team's version, and writes exactly what setup
always wrote: `.jira-agent/project.yaml` and `.mcp.json`. Discovery is allowed;
adoption is asked for.

```text
✓ Workspace bound            WEB
  Recorded for you only - the repository was not touched.
✓ Registered with            claude-code
! codex was not reachable, so JAM was not registered with it.
› If you use it, run: codex mcp add jam -- npx --yes @jam-mcp/launcher@1.4.5 serve
```

**A rebind names what it replaces.** `jam setup --project OTHER` on a workspace
that is already bound previews `WEB → OTHER` before it writes, so nobody
discovers the change afterwards.

**A committed project key wins, and the disagreement is reported.** If the team
adopted JAM after you bound the repo personally, `.jira-agent/project.yaml` is
the answer and JAM says so - it does not silently ignore one of them, and it
does not delete your binding for you.

**A host is never guessed at.** JAM registers itself by running the host's own
command, so it never edits `~/.claude.json` or `~/.codex/config.toml`. A host
that cannot be reached is reported with the command to run by hand, and nothing
is claimed to have happened.

## Terminal acceptance

Unit tests drive a pipe, and a pipe has no IME, no character width and no
terminal line editor. The behaviour this section is about only exists on a real
terminal, so it is checked by a person there, on each platform, against this
list. A failing row blocks the change; it is not a footnote.

Run `jam auth login` and, at **Paste your Jira URL**:

```text
ASCII typed, then Backspace
여러 글자 한글 입력, 연속 Backspace로 전부 삭제
한글 조합 도중 Backspace
한/영 혼합, 한글 + 영문 + 숫자
←  →  Home  End 로 커서 이동한 뒤 중간 삽입
paste
Enter on an empty line takes the [offered] value
Ctrl-C exits 130, Ctrl-D and a closed stdin cancel too
three unusable URLs end with "after 3 attempts"
```

Then at **Atlassian API token**: nothing echoes, paste works, Backspace
deletes, Enter submits, Esc cancels.

| Platform | Status |
|---|---|
| Windows Terminal | pending |
| macOS Terminal | pass — 2026-08-26, every row above |
| Linux | pending — no device |

Record the outcome here rather than in a commit message: the next person to
touch `ui.ts` needs to know which platforms were actually exercised.

A pty covers all of it except IME composition. Driving `script -q /dev/null`
with timed keystrokes gives readline a real terminal, so backspace over
precomposed Hangul, cursor movement, paste, the `[offered]` fallback, the exit
codes and the whole token step are all checkable without a person - and the
same capture proves the token never echoed, because a sentinel typed into it
appears nowhere in the transcript. What a pty cannot produce is an IME pre-edit
buffer: "한글 조합 도중 Backspace" is composing state that only a real input
method creates, so that one row stays a human check.

## Machine output

For agents and scripts:

```bash
npx --yes @jam-mcp/bootstrap@1.4.5 setup plan --json
npx --yes @jam-mcp/bootstrap@1.4.5 setup apply --non-interactive --json
npx --yes @jam-mcp/bootstrap@1.4.5 setup --agent
npx --yes @jam-mcp/bootstrap@1.4.5 doctor --json
npx --yes @jam-mcp/bootstrap@1.4.5 runtime --json
npx --yes @jam-mcp/bootstrap@1.4.5 auth status --json
```

A locally installed `jam` runs each of these identically, and this document
writes the short form elsewhere for readability. Bootstrap stays the
zero-state default — the machine an agent lands on usually has no global
install. But the launcher is no longer ruled out on a fresh machine: it
answers `jam runtime use package` itself, so `npm install -g
@jam-mcp/launcher@1.4.5` followed by that one command reaches the same place.
That persistent path is also the fallback when `npx` itself cannot start a
process (a package-runner failure, which is not a JAM failure).

The contract:

- **stdout is one parseable JSON document and nothing else.** Not "JSON plus a
  banner", not "JSON somewhere in the output". Tests parse the whole of stdout.
- No ANSI escapes anywhere in it.
- No prompts, ever — these paths are non-interactive by construction.
- Diagnostics go to stderr.
- Status codes are stable and branchable; callers must never have to
  pattern-match prose.
- Credentials never appear. `auth status` reports presence and origin only,
  and is always JSON - it has no human-facing form to drift from.

Human-facing colour output and the machine interface are separate paths. Adding
a decorative line to the JSON path is a breaking change.

## Related

- [Distribution and bootstrap](../architecture/distribution-and-bootstrap.md)
- [ADR: unified runtime and agent setup](../decisions/adr-unified-runtime-and-agent-setup.md)
