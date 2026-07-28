---
title: No Forgetti documentation
description: Project-scoped persistent memory and self-forming skills for Pi.
---

# Memory that stays with the project

No Forgetti gives [Pi](https://github.com/earendil-works/pi-mono) durable, project-scoped memory and reusable project skills. State stays outside the repository, so learning does not create project-file churn.

<div class="actions">

[Install No Forgetti](./getting-started.md)
[Set up external mode](./external-mode/setup.md)
[View on GitHub](https://github.com/Jeecabs/no-forgetti)

</div>

::: tip New to No Forgetti?
Start with [Getting started](./getting-started.md). The default embedded reviewer requires no daemon or service configuration.
:::

## How it works

<video controls preload="none" width="1920" height="1080" poster="/how-it-works-poster.jpg" src="/how-it-works.mp4"></video>

A one-minute walkthrough of the same ground as [The short version](#the-short-version) below: how memory is scoped to a project, the two ways it changes, what automatic review is allowed to admit, and where review can run. The video is silent, so nothing in it is lost by reading instead.

## Choose what you need

| Task | Start here |
| --- | --- |
| Install the extension and confirm it loaded | [Getting started](./getting-started.md) |
| Understand what No Forgetti remembers | [Project memory](./guide/memory.md) |
| Create and manage reusable workflows | [Project skills](./guide/project-skills.md) |
| Let reviews finish after Pi exits | [External mode](./external-mode/index.md) |
| Set up the external worker end to end | [External mode setup](./external-mode/setup.md) |
| Diagnose an offline or stalled worker | [Operations and troubleshooting](./external-mode/operations.md) |
| Look up a slash command | [Command reference](./reference/commands.md) |
| Find or remove local state | [Storage reference](./reference/storage.md) |

## The short version

- **Scope follows the project.** The nearest Git root identifies memory. Without Git, the exact launch directory does.
- **Writes are immediate.** The `project_memory` tool updates canonical project state directly.
- **Review is conservative.** Automatic review runs only after a successfully settled turn and validates changes before admission.
- **Skills use Pi’s native path.** Active generated skills appear in Pi’s skill index and load progressively when read or invoked.
- **External mode is optional.** The default `embedded` mode reviews in Pi. `external` mode moves accepted review jobs to a separately managed worker.

## External mode, in one sentence

Use external mode when memory review must survive Pi shutting down. Pi captures and queues bounded evidence; a user-scoped worker calls the configured reviewer and attempts a compare-and-swap update against current project memory.

External mode does **not** move foreground memory writes out of Pi, review project skills, or import old sessions. [See the complete boundary](./external-mode/index.md).
