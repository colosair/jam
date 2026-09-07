# JAM — current architecture

What JAM is today. `jira-agent-mcp-design.md` is the design baseline this grew out of and
is preserved as such; where the two differ, this file is the current one.

## What JAM is responsible for

JAM is the Jira access layer: safe reads, and writes that cannot happen by accident.

```text
JAM does        read Jira in shapes an agent can act on
                write Jira through plan → apply → verify, inside one bound project
                register itself with the hosts that launch it

JAM does not    decide whether a write should happen — that is ASC's decision path
                manage sessions, ownership, approval or execution mode
                hold project workflow rules
```

There is no Execution Mode in JAM. MANUAL/AUTO belongs to ASC, and a Jira write reaches
JAM only after ASC's own decision path has settled that it should.

## Five MCP tools, and no more

```text
read   jira_search        listing, discovery, current status
       jira_context       readiness, blockers, dependencies, priority
       jira_full          agreement, contract, approval, closure

write  jira_write_plan    reads the issue, checks the change is possible, describes it.
                          Changes nothing. Also creates issues (operation issue.create)
       jira_write_apply   takes a planId and nothing else. No payload to override the plan
```

The count is part of the contract: a host that lists a sixth `jira_*` tool is running
something other than this build. An earlier design fixed the surface at three read tools;
the two write tools arrived with the write plane and the total has been five since.

**There is no way to write without planning first.** `jira_write_apply` accepts a planId,
so the change that lands is the change the plan described and nothing else. Writes are
confined to the bound project and confirmed by reading the issue back — a write JAM could
not verify is never reported as done.

## Identity and status vocabulary

```text
key              a locator. It can be re-pointed; it is not identity
issueId          Jira's immutable identity for the issue
statusCategory   Jira's own semantic category (to-do / in-progress / done),
                 not a name JAM invents from the workflow's status labels
```

Reading the category from Jira rather than mapping status names is what keeps JAM correct
on projects whose workflows use names nobody else has seen.

## Read path

Every read result carries a `meta` block, and it describes JAM's retrieval — never the
project:

```text
meta.complete        the read finished with no known loss.
                     Not a claim that Jira holds the whole story
meta.evidenceScope   what was looked at
meta.limitations     what was not evaluated — the repository and every external source
                     among them
```

A `jira_search` result is never complete issue context; that is what `jira_context` and
`jira_full` are for.

## Write path

```text
jira_write_plan     read the issue → check the change is possible against Jira's own
                    create/edit schema → describe what would happen
jira_write_apply    apply that plan → read the issue back → report what is now true

conflicts           JAM_WRITE_CONFLICT / JAM_WRITE_PLAN_EXPIRED → plan again against
                    the current state
unknown outcome     JAM_WRITE_UNCERTAIN → read the issue. Never retry the apply, which
                    could apply the change twice
```

## Lifecycle

The same six words ASC uses, for the same reason — a person should not have to remember
which product uses which verb.

```text
setup       bind this project and verify it. Personal by default; --shared writes the
            project files for a team
status      what is configured, what works, what is blocked (jam doctor is the old name)
update      move this machine's registration to the published release
refresh     keep the version; re-register what this build owns
uninstall   remove JAM's registrations and the global launcher. ~/.jam stays
runtime     which build this machine actually runs
```

What goes stale in JAM is a registration line, not a directory: the host launches JAM from
an entry carrying an exact pin, so a newer release on the registry changes nothing until
that pin moves. `update` moves it to a newer version; `refresh` moves it back to the build
already installed here. Neither re-plans the project binding — that is `setup`'s job, and
conflating them is how a person loses a binding they never asked to change.

`uninstall` keeps `~/.jam/projects.yaml`, `~/.jam/config.yaml`, the credentials in the OS
secret store and every `.jira-agent/project.yaml`. There is no purge.

## Boundaries

```text
project layer   what has to be done and by which convention
ASC             ownership · what a person must decide · whether an action is executable
                now · execution · audit
JAM             safe access to Jira
Jira            the system of record
```

JAM never reaches past Jira, and nothing above it writes Jira except through the plan and
apply pair. ASC and JAM version independently: neither updates the other, neither pins the
other.

## Where the details live

```text
docs/architecture/jira-agent-mcp-design.md      the design baseline (historical)
docs/architecture/distribution-and-bootstrap.md  how the packages and hosts fit together
docs/decisions/                                  ADRs, including the write plane
docs/operations/release.md                       how a release is run today
```
