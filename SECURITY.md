# Security

JAM reads Jira on your behalf. It handles an Atlassian API token, talks to your
Jira site, and stores credentials in your operating system's secret store — so
a bug here can expose more than a bug in most tools of its size. Reports are
welcome.

## Supported versions

JAM ships as three packages at one lockstep version. Fixes go to the latest
release; older versions are not patched.

| Line | Supported |
|---|---|
| The latest published release | yes |
| Older releases | no — not maintained unless a security advisory says otherwise |

Check what is latest with `npm view @jam-mcp/launcher version`, and what a
machine runs with `jam runtime status --json`.

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting**, on the
[Security tab](https://github.com/colosair/jam/security/advisories/new) of this
repository. That channel is private to the maintainers and lets us discuss a
fix before anything is public.

Do **not** open a public issue for a suspected vulnerability, and do not
describe one in a pull request, a discussion, or a commit message.

Useful in a report: which version, what an attacker can do, and the smallest
sequence of steps that shows it. A proof of concept helps; it is not required
if describing the flaw is enough.

Expect an acknowledgement within a week. If a report is valid, we will agree a
disclosure timeline with you and credit you in the release notes unless you
would rather we did not. If it is not, we will say why.

## Never put credentials in a report

No Jira API tokens, no `Authorization` headers, no session cookies, no `.env`
contents — not in an issue, not in a private report, not in an attached log.
Redact them, and describe the shape of the value instead of pasting it.

If a report or a log would only make sense with a real token in it, say so and
we will find another way.

**If you have already leaked a token** — in an issue, a screenshot, a commit,
anywhere — treat it as compromised regardless of how quickly it was deleted.
Revoke it at
[id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
first, then tell us so we can scrub what we can reach. Deleting the message is
not a substitute for revoking the token.

## What JAM already promises

These are properties the codebase holds itself to, and a break in any of them
is a security bug worth reporting:

- Credentials never appear in logs, telemetry, error messages, MCP tool
  results, or any file JAM writes into a repository.
- The API token is never passed as a command-line argument, where other
  processes on the machine could read it.
- `jam setup` writes nothing into a repository unless asked with `--shared`,
  and never writes credentials into a repository at any scope.
- JAM does not modify `PATH` or other user environment variables, and does not
  edit a coding agent's configuration file directly — it asks that agent's own
  CLI to do it.
- `stdout` belongs to the MCP protocol; diagnostics go to `stderr`.
- Each person authenticates as themselves. JAM shares read policy, not
  permissions, and is not designed to sit behind a shared service account.

## Scope

In scope: credential handling, the MCP server, the setup and migration paths,
and anything JAM writes to disk.

Out of scope: vulnerabilities in Jira itself or in the Atlassian API, and
issues that require an attacker to already control the machine JAM runs on.
Report those to Atlassian, or fix the machine.
