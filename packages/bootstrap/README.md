# @jam-mcp/bootstrap

The zero-install way into [JAM (Jira Agent MCP)](https://github.com/colosair/jam).

This package exists so the *first* command a person or a coding agent runs needs
nothing installed beforehand:

```bash
npx --yes @jam-mcp/bootstrap@1.4.0 init          # for a person
npx --yes @jam-mcp/bootstrap@1.4.0 setup --agent # for a coding agent, JSON only
```

`init` chooses how JAM runs on this machine and wires up the current project.
`setup --agent` detects, plans, applies what is safe, and verifies — stopping
only where a person is genuinely required (choosing a Jira project,
authenticating).

## What it is, and is not

It is an end-user entry point, but it holds **no setup logic of its own**. It
depends on `@jam-mcp/server` at an exact version and forwards to the same
commands JAM's own CLI would run; anything other than `init` is passed through
unchanged. Any decision made here would be a second implementation to keep in
sync with the setup core.

That pass-through is also why bootstrap is what JAM names in machine-readable
instructions. On a machine that has just met JAM there is no global command to
call and no configured runtime for the launcher to dispatch to — bootstrap
needs neither, so `npx --yes @jam-mcp/bootstrap@1.4.0 <anything>` works when
nothing else does.

The three packages divide up like this:

| Package | Role |
|---|---|
| `@jam-mcp/bootstrap` | first run and recovery — needs nothing installed |
| `@jam-mcp/launcher` | what a coding agent registers; resolves which JAM build runs |
| `@jam-mcp/server` | JAM itself: MCP tools, setup core, CLI |

Day to day you don't need this package: your coding agent launches the
launcher, and if you installed the launcher globally you have `jam` too.

## More

- [Repository README](https://github.com/colosair/jam#readme)
- [Distribution and bootstrap](https://github.com/colosair/jam/blob/main/docs/architecture/distribution-and-bootstrap.md)
