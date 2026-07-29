# Command reference

## Memory

| Command | Purpose |
| --- | --- |
| `/memory status` | Open the operational monitor for the current project |
| `/memory show` | Display the active memory branch |
| `/memory branches` | List available memory branches |
| `/memory fork <name>` | Clone the active branch and select the copy in this Pi session |
| `/memory use <name>` | Select an existing branch in this Pi session |
| `/memory review` | Request memory review after the turn settles |
| `/memory review retry [job-id]` | Requeue retained evidence from the latest failed external review |
| `/memory undo` | Safely invert the latest eligible automatic review |

## Project skills

| Command | Purpose |
| --- | --- |
| `/project-skills` | Open the interactive project-skill browser |
| `/project-skills list` | List active project skills |
| `/project-skills stats` | Show recall frequency and inactivity |
| `/project-skills read <name>` | Read a skill package |
| `/project-skills edit <name>` | Edit a skill and snapshot a revision |
| `/project-skills undo <name>` | Preview and revert the latest eligible skill revision |
| `/project-skills pending` | List pending proposals |
| `/project-skills approve <name>` | Approve a pending archive or compatible legacy proposal |
| `/project-skills reject <name>` | Reject a pending proposal |
| `/project-skills review` | Request project-skill review after the turn settles |

Use Pi’s native `/skill:<name>` command to invoke an active project skill. No Forgetti manages the skill lifecycle; Pi manages discovery and invocation.

## Model tool

The foreground model receives `project_memory` with four actions:

```text
list
add(content, importance?)
replace(oldText, content, importance?)
remove(oldText)
```

For `replace` and `remove`, `oldText` must be a unique substring of one existing entry. Importance can be `high`, `normal`, or `low` and measures the cost of forgetting.

## Doctor CLI

```text
no-forgetti doctor [--json] [--agent-dir <path>] [--projects-root <path>]
```

The doctor checks the installed release, the global package source, project overrides, live Pi runtimes, and the external worker. It exits with status 1 if the machine has a stale or mixed installation.

## Worker CLI

```text
no-forgetti review [--once] [options]
```

| Option | Purpose |
| --- | --- |
| `--once` | Drain currently queued reviews, then exit |
| `--agent-dir <path>` | Pi agent directory; defaults to `PI_CODING_AGENT_DIR` or `~/.pi/agent` |
| `--worker-id <id>` | Stable spool worker identifier |
| `--lease-ms <number>` | Durable claim lease duration |
| `--poll-ms <number>` | Idle polling interval |
| `--max-attempts <count>` | Terminal retry limit for non-configuration failures |
| `-h`, `--help` | Show CLI help |

For service-manager use, invoke the worker script with absolute Node, worker, and agent-directory paths. See [External mode setup](../external-mode/setup.md).
