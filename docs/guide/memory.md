# Project memory

Project memory is a short, durable record for one project. Pi loads the active memory branch before each turn. Future sessions can follow established conventions without rediscovering them.

::: tip A simple test
Store a fact when it should still help in a future session and does not already exist in project documentation.
:::

## Choose what to remember

Keep facts that are stable and expensive to rediscover. For example:

- `Use pnpm check before pnpm test.`
- `The API package owns request validation.`
- `Prefer named options objects when an API includes boolean settings.`
- `The release script requires a clean Git worktree.`

Memory is also useful for architecture facts, recurring project preferences, and non-obvious tool behavior.

Leave out facts that are temporary, sensitive, or already documented. Do not store:

- current task progress or completed-work diaries
- issue numbers, pull request numbers, or commit hashes
- raw logs and tool output
- temporary failures
- secrets
- facts from `AGENTS.md` or other checked-in project documents

Each entry has `high`, `normal`, or `low` importance. Importance measures the cost of forgetting. It does not measure certainty, age, or urgency.

## How memory changes

No Forgetti has two write paths:

| Path | When it runs | Result |
| --- | --- | --- |
| Direct write | Pi uses the `project_memory` tool during a turn | Saves the change immediately |
| Automatic review | Pi completes a successful turn and becomes idle | Reviews recent evidence and proposes bounded changes |

### Direct writes

The `project_memory` tool can list, add, replace, or remove entries. Each change writes to the active memory branch immediately. No background reviewer or external worker delays the change.

Pi reloads the active branch before the next turn. This makes writes from other sessions and review processes visible without a manual refresh.

### Automatic review

Automatic review follows this sequence:

1. Pi completes a successful turn and becomes idle.
2. No Forgetti selects the oldest unreviewed evidence window.
3. No Forgetti removes sensitive or unnecessary evidence.
4. The reviewer proposes additions, replacements, removals, or consolidations.
5. No Forgetti validates the proposal against the memory policy.
6. No Forgetti commits the proposal only when the branch still matches the reviewed version.

Step 6 uses compare-and-swap (CAS). CAS prevents a stale review from overwriting a newer memory change.

A review window contains at most 12 user turns and 32,000 sanitized characters. No Forgetti excludes thinking, images, raw tool arguments, raw tool results, user Bash, provider headers, and diagnostics.

No Forgetti advances the review position only through evidence in the selected window. This prevents a truncated window from skipping evidence.

## Capacity controls

Memory has four capacity controls:

| Control | Size | Effect |
| --- | ---: | --- |
| Entry limit | 800 characters | Keeps each fact compact |
| Maintenance goal | 4,000 characters | Guides lossless consolidation |
| Working target | 4,500 characters | Limits growth from automatic review |
| Hard limit | 6,000 characters | Reserves capacity for direct writes |

Automatic review below the working target cannot cross it. At or above the target, review can keep the same size or shrink toward the maintenance goal. Direct writes can use the reserved capacity up to the hard limit. Exact duplicate entries have no effect.

## Inspect and undo

| Command | Result |
| --- | --- |
| `/memory status` | Show the project, active branch, capacity, and review mode |
| `/memory show` | Show entries in the active branch |
| `/memory branches` | List all memory branches |
| `/memory undo` | Undo the latest eligible automatic review |

Each changed automatic review creates an immutable revision record. `/memory undo` reverts reviewed entries only when they still match that revision. It preserves unrelated later writes. It stops if a later write changed a reviewed entry.

## Use a separate memory branch

Pi `/fork` and `/clone` commands create session histories. They do not create memory branches.

Create an independent copy of the active memory branch when an experiment needs different facts:

```text
/memory fork experiment
```

This command switches only the current Pi session to the new branch. Switch the session back to `main` when the experiment ends:

```text
/memory use main
```

No Forgetti stores the selected branch in Pi session state. If Pi does not persist the session, the selection lasts only for the current process.

## Project scope

No Forgetti identifies the project with this order:

1. Use the nearest Git root.
2. If no Git root exists, use the exact Pi launch directory.

Each Git worktree receives separate memory because each worktree has a different root.

Gang members and Pi subagents do not load or write project memory. Only the primary or superintendent session can use it.

No Forgetti stores memory outside the repository. See the [storage reference](../reference/storage.md) for paths, permissions, and retention details.
