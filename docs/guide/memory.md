# Project memory

Project memory is a small, durable set of facts that helps future Pi sessions work correctly without rediscovering the same conventions.

## Scope

No Forgetti identifies a project by:

1. the nearest Git root; or
2. the exact Pi launch directory when no Git root exists.

Git worktrees intentionally receive separate memory because their canonical working-tree roots differ. Gang and Pi subagent children are memory-isolated; only the primary or superintendent session loads and writes No Forgetti memory.

## What belongs in memory

Good entries are stable and expensive to rediscover:

- project conventions
- architecture facts
- canonical verification commands
- recurring project-specific preferences
- non-obvious workflows or tool quirks

Do not store:

- task progress or completed-work diaries
- issue numbers, pull request numbers, or commit hashes
- raw logs and tool output
- temporary failures
- secrets
- facts already documented in `AGENTS.md` or checked-in project docs

Importance is `high`, `normal`, or `low`. It measures the cost of forgetting—not certainty, age, or urgency.

## Immediate writes and automatic review

The foreground `project_memory` tool writes directly to canonical project JSON. These writes do not wait for the background reviewer or external worker.

Automatic review runs only after a successfully settled turn. It sees bounded, sanitized evidence and can add, replace, remove, merge, or assess entries. A proposal must pass memory-policy validation and an exact branch-digest compare-and-swap before it can commit.

Memory has four capacity boundaries:

| Boundary | Size | Meaning |
| --- | ---: | --- |
| Maintenance goal | 4,000 characters | Lossless maintenance aims for this size |
| Review target | 4,500 characters | Automatic review cannot grow beyond this target |
| Hard limit | 6,000 characters | Reserves space for foreground writes |
| Per entry | 800 characters | Keeps individual facts compact |

Reviews below the target cannot cross it. Reviews at or above the target cannot grow memory. Exact duplicates are ignored.

## Branches and Pi sessions

Normal, new, forked, and cloned Pi sessions keep using the same `main` memory branch. Pi’s `/fork` and `/clone` commands do not clone project memory.

Create an independent copy explicitly:

```text
/memory fork experiment
```

This clones the active branch and switches only the current Pi session to it. Switch back with:

```text
/memory use main
```

The selected branch is stored in Pi session state. With Pi session persistence disabled, the selection lasts only for the current process.

## Inspect and undo

```text
/memory show
/memory branches
/memory undo
```

Changed automatic reviews append immutable revision records. `/memory undo` performs an inverse compare-and-swap: it reverts the reviewed fields only when they still match. It refuses to erase later conflicting writes, while unrelated later additions survive.

## Review timing

Review starts only after Pi is fully settled at the end of a completed turn. No Forgetti processes the oldest bounded unreviewed window and advances only through evidence actually included in that window. This prevents evidence truncation from skipping history.

Accepted external jobs contain at most 12 user turns and 32,000 sanitized characters. Thinking, images, raw tool arguments and results, user Bash, provider headers, and diagnostics are excluded.
