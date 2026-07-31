<p align="center">
  <img src="assets/no-forgetti-logo.jpg" alt="No Forgetti elephant logo" width="240">
</p>

<h1 align="center">No Forgetti</h1>

<p align="center">Project-scoped persistent memory and self-forming skills for Pi.</p>

No Forgetti ports the useful part of [Hermes Agent](https://github.com/NousResearch/hermes-agent)’s learning loop without turning Pi sessions into one global memory stream.

**[Read the documentation](https://jeecabs.github.io/no-forgetti/)** · [Getting started](docs/getting-started.md) · [External mode setup](docs/external-mode/setup.md)

## What it does

- **Scopes memory to the project.** The nearest Git root identifies memory; without Git, the exact launch directory does.
- **Persists writes immediately.** Every turn reloads the active branch, so foreground tools, review, and other sessions become visible without a manual refresh.
- **Reviews only settled work.** Automatic learning starts after a successfully completed turn and admits only validated, bounded changes.
- **Forms project skills.** Repeatable workflows become standard `SKILL.md` packages exposed through Pi’s native skill discovery and `/skill:<name>`.
- **Keeps state outside the repository.** Memory and generated skills do not create project-file churn.
- **Supports durable review.** Optional external mode queues accepted memory-review work for a separately managed worker, so Pi can exit without aborting it.

## Install

Install globally for all Pi projects:

```bash
pi install https://github.com/Jeecabs/no-forgetti
pi list
```

Restart Pi after the first install, or run `/reload` in an existing interactive session. Then verify:

```text
/memory status
```

Project-local install:

```bash
pi install -l https://github.com/Jeecabs/no-forgetti
```

Try for one process without changing settings:

```bash
pi -e https://github.com/Jeecabs/no-forgetti
```

See [Getting started](docs/getting-started.md) for requirements, install scopes, and the first-use walkthrough.

## Review modes

| Mode | Behavior |
| --- | --- |
| `embedded` | Default. Pi reviews memory in process; no service setup required. |
| `shadow` | Pi remains authoritative and also writes sanitized deterministic jobs for inspection. |
| `external` | Pi durably queues accepted jobs; a user-scoped worker owns review and CAS admission. |

External mode is opt-in and processes **memory review only**. Foreground `project_memory` writes remain immediate in Pi, and project-skill review stays in Pi.

If review must survive Pi exit, follow the dedicated guide in order:

1. [Understand external mode](docs/external-mode/index.md)
2. [Configure and test it once](docs/external-mode/setup.md)
3. Register it with [macOS `launchd`](docs/external-mode/macos.md) or [Linux `systemd --user`](docs/external-mode/linux.md)
4. [Operate and troubleshoot it](docs/external-mode/operations.md)

No Forgetti never starts a daemon during package installation.

## Core commands

```text
/memory status
/memory show
/memory branches
/memory fork <name>
/memory use <name>
/memory review
/memory review retry
/memory undo

/project-skills
/project-skills list
/project-skills stats
/project-skills read <name>
/project-skills edit <name>
/project-skills delete <name>
/project-skills undo <name>
/project-skills pending
/project-skills approve <name>
/project-skills approve-all
/project-skills reject <name>
/project-skills review
```

Use `no-forgetti doctor` after an external-mode update. It checks the installed release, live Pi runtimes, and the worker. Add `--projects-root <path>` to scan Git roots for local overrides.

See the [command reference](docs/reference/commands.md) for behavior and worker CLI options.

## Documentation

- [Getting started](docs/getting-started.md)
- [Project memory](docs/guide/memory.md)
- [Project skills](docs/guide/project-skills.md)
- [External mode](docs/external-mode/index.md)
- [Storage reference](docs/reference/storage.md)
- [Security model](SECURITY.md)
- [External curator architecture](docs/architecture/external-curator.md)
- [Contributing](CONTRIBUTING.md)

## Design boundaries

Memory has a 4,000-character maintenance goal, a 4,500-character automatic-review target, a 6,000-character hard limit, and an 800-character per-entry limit. Foreground writes retain reserved capacity. Automatic review uses branch compare-and-swap, append-only revision history, and inverse-CAS undo that refuses to erase later conflicting writes.

Accepted review evidence is bounded to 12 user turns and 32,000 sanitized characters. It excludes thinking, images, raw tool arguments and results, user Bash, provider headers, and diagnostics. Review [SECURITY.md](SECURITY.md) before enabling external mode.

## Development

```bash
git clone https://github.com/Jeecabs/no-forgetti.git
cd no-forgetti
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm docs:install
pnpm docs:build
pi -e .
```

Run the documentation site locally:

```bash
pnpm docs:dev
```

No Forgetti is released under the [MIT License](LICENSE). Upstream inspiration is noted in [NOTICE.md](NOTICE.md).
