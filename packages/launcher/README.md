# @jam-mcp/launcher

The entry point a coding agent registers for [JAM (Jira Agent MCP)](https://github.com/colosair/jam).

This package is deliberately thin. It resolves *which* JAM build this machine
should run, then dispatches to it — it holds no Jira logic of its own. That
indirection is what lets a committed `.mcp.json` name no machine-specific path:

```json
{
  "mcpServers": {
    "jam": { "command": "npx", "args": ["--yes", "@jam-mcp/launcher@1.0.0", "serve"] }
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

Configure it with `jam runtime use package | development <path>`, or during
first-run setup.

## Usage

Normal use is indirect: your coding agent launches `jam-launcher serve` and
speaks MCP to whatever it dispatched to. Any other command is forwarded to the
configured runtime unchanged, so `jam-launcher doctor` reaches the same
diagnosis as `jam doctor`.

Prefer the launcher over invoking `@jam-mcp/server` directly. Calling the
server by hand pins one machine to one build and bypasses the runtime config
that `jam runtime` manages.

## More

- [Repository README](https://github.com/colosair/jam#readme)
- [Distribution and bootstrap](https://github.com/colosair/jam/blob/main/docs/architecture/distribution-and-bootstrap.md)
