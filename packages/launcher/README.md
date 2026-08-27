# @jam-mcp/launcher

The entry point a coding agent registers for [JAM (Jira Agent MCP)](https://github.com/colosair/jam).

This package is deliberately thin. It resolves *which* JAM build this machine
should run, then dispatches to it — it holds no Jira logic of its own. That
indirection is what lets a committed `.mcp.json` name no machine-specific path:

```json
{
  "mcpServers": {
    "jam": { "command": "npx", "args": ["--yes", "@jam-mcp/launcher@1.2.0", "serve"] }
  }
}
```

## Runtimes

Runtime selection lives in `~/.jam/config.yaml`, per machine, never in a
project:

- **package** — runs the published `@jam-mcp/server` at an exact version. The
  default, and what a teammate gets.
- **development** — runs a local checkout of `@jam-mcp/server`, for people
  working on JAM itself.

Set it during first run, or with `runtime use package` / `runtime use
development <path>`.

## Usage

Normal use is indirect: your coding agent launches `jam-launcher serve` and
speaks MCP to whatever it dispatched to. Any other command is forwarded to the
configured runtime unchanged, so `jam-launcher doctor` reaches the same
diagnosis JAM's own CLI would.

## The optional `jam` command

This package installs under two names from one entry point: `jam-launcher`,
and `jam` for people who want the short form.

```bash
npm install -g @jam-mcp/launcher@1.2.0
```

That is a convenience, not a prerequisite. JAM is fully usable without it —
your editor launches the launcher through `npx`, and so can you. Nothing JAM
writes or hands to a machine assumes `jam` is on anyone's PATH: a shared
`.mcp.json` names the `npx` form, and so does every command JAM tells a script
to run.

Note what `jam` is *not*: it is not a global install of JAM. It is this
dispatcher, which still reads `~/.jam/config.yaml` and still runs the runtime
selected there. Installing `@jam-mcp/server` globally instead would pin one
machine to one build and bypass that choice.

## More

- [Repository README](https://github.com/colosair/jam#readme)
- [Distribution and bootstrap](https://github.com/colosair/jam/blob/main/docs/architecture/distribution-and-bootstrap.md)
