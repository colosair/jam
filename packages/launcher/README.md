# @jam-mcp/launcher

The entry point a coding agent registers for [JAM (Jira Agent MCP)](https://github.com/colosair/jam).

This package is deliberately thin. It resolves *which* JAM build this machine
should run, then dispatches to it — it holds no Jira logic of its own. That
indirection is what lets a committed `.mcp.json` name no machine-specific path:

```json
{
  "mcpServers": {
    "jam": { "command": "npx", "args": ["--yes", "@jam-mcp/launcher@1.4.0", "serve"] }
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

## The persistent `jam` command

This package installs under two names from one entry point: `jam-launcher`,
and `jam` for people who want the short form.

```bash
npm install -g @jam-mcp/launcher@1.4.0
```

That is the **persistent** way to run JAM, and it is self-sufficient: the
launcher carries the matching server as an exact dependency, answers `jam
runtime use package` itself (creating `~/.jam/config.yaml` — the one command
that cannot require the file it creates), and in package mode runs that
installed server directly under the current Node rather than through `npx`.

That last part is the point. `npx` is the zero-install entry, not JAM's
lifeline: on a machine whose package runner is broken — a real Windows npm
11.6.2 was seen failing to put the cache's `.bin` on a child's PATH, before
any JAM code ran — the persistent install is the path that still works. An
`npx` failure of that kind is a package-runner failure, not a JAM one.

Nothing JAM writes assumes `jam` is on anyone's PATH: a shared `.mcp.json`
still names the `npx` form, and so does every command JAM tells a script to
run. But a registration someone made against their own global `jam` is
respected — `--migrate` no longer rewrites it back to `npx`.

`jam` is still this dispatcher: it reads `~/.jam/config.yaml` and runs the
runtime selected there, so `runtime use development <checkout>` keeps working
exactly as before.

## More

- [Repository README](https://github.com/colosair/jam#readme)
- [Distribution and bootstrap](https://github.com/colosair/jam/blob/main/docs/architecture/distribution-and-bootstrap.md)
