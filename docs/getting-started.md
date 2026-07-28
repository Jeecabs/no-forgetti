# Getting started

The default installation is deliberately uneventful: install the Pi package, reload Pi, and use No Forgetti. External mode is a separate opt-in setup.

## Requirements

- Node.js 22.19 or newer
- Pi 0.81.0 or newer
- A project directory, preferably inside a Git repository

## Install for all projects

```bash
pi install https://github.com/Jeecabs/no-forgetti
pi list
```

Restart Pi after the first install, or run `/reload` in an existing interactive session. `pi list` should show the No Forgetti package.

### Other install scopes

Install only for the current project:

```bash
pi install -l https://github.com/Jeecabs/no-forgetti
```

Try it for one Pi process without changing settings:

```bash
pi -e https://github.com/Jeecabs/no-forgetti
```

Pi also accepts Git shorthand:

```bash
pi install git:github.com/Jeecabs/no-forgetti
```

::: warning External worker path
A temporary `pi -e` checkout is not suitable for a persistent external worker. The checkout disappears when that Pi process ends. Use a normal global, project-local, or local-path installation before configuring external mode.
:::

## Confirm the extension loaded

Open Pi in a project and run:

```text
/memory status
```

The status view should show the current project root, memory branch, capacity, and review mode. With no service configuration, the mode is `embedded`.

Then inspect the initially empty memory:

```text
/memory show
```

No repository files are created. State defaults to `~/.pi/agent/no-forgetti/`, or the equivalent path beneath `PI_CODING_AGENT_DIR` when that variable is set.

## What happens next

During normal work:

1. Pi injects the active project-memory branch before each agent turn.
2. Foreground `project_memory` writes persist immediately.
3. After a successful settled turn, No Forgetti records eligible evidence and checks the review cadence.
4. Review proposes only validated, bounded changes.
5. Project skills can form from successful, repeatable workflows.

The periodic memory-review fallback is 10 completed user prompts. Explicit signals can trigger review earlier, and `/memory review` requests one on demand.

## Choose a review mode

| Mode | Who reviews? | Extra setup | Use when |
| --- | --- | --- | --- |
| `embedded` | The active Pi process | None | You want the simplest setup |
| `shadow` | Pi; sanitized jobs are also mirrored | Optional inspection tooling | You are evaluating external transport without changing authority |
| `external` | A separate No Forgetti worker | Reviewer profile and OS user service | Review must survive Pi exit |

Stay on `embedded` unless you specifically need durable out-of-process review. To continue, read [How external mode works](./external-mode/index.md), then follow [Set up external mode](./external-mode/setup.md).

## Local development

```bash
git clone https://github.com/Jeecabs/no-forgetti.git
cd no-forgetti
pnpm install --frozen-lockfile
pnpm check
pnpm test
pi -e .
```

A local `pi install .` references the checkout in place. Do not move or delete that checkout while it remains installed.
