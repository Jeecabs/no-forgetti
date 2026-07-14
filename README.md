# No Forgetti

Project-scoped persistent memory for Pi. No Forgetti ports the useful part of Hermes' learning loop without turning Pi sessions into one global memory stream.

## Behavior

- Memory scope = nearest Git root; when no Git root exists, exact launch directory.
- Default branch = `main` for every new session in that project.
- Pi `/fork` and `/clone` keep using the same memory branch. They **do not** clone memory automatically.
- `/memory fork <name>` explicitly clones the active memory and switches only the current Pi session to it. With Pi session persistence disabled, that selection lasts only for the current process.
- Writes persist immediately, but injected context stays frozen until the next session, explicit `/memory refresh`, or successful Pi compaction. Compaction is already a prompt-cache boundary, so it safely adopts the latest memory.
- Review runs only after Pi is fully settled at the end of a completed turn, in a background request after the response. Explicit memory signals and durable corrections can trigger it early; otherwise 10 completed prompts provide a periodic fallback. Resuming a session with unreviewed history triggers one pass on its next completed turn, matching Hermes' existing-session behavior. Branch-aware custom cursors ensure extraction sees only unreviewed turns; successful empty reviews advance the cursor. Failed reviews back off instead of retrying every turn. `/memory review` runs it on demand.

This is filesystem memory, not model training. It stores compact project facts and injects a bounded snapshot into the system prompt.

## Design boundary

- **Learning** happens only after a successfully completed turn: propose compact additions, replacements, or removals from recent conversation evidence.
- **Maintenance** happens inside that same atomic mutation when necessary: overlapping or stale facts are consolidated to stay within the fixed budget.
- No scheduled curator is needed for a 2,200-character state. There is no skill pruning, archival lifecycle, graph database, or background maintenance agent.
- No Forgetti does not mutate Pi skills. A future read-only journey view could visualize memory branches, but it is deliberately outside the persistence core.
- Durable state intentionally lives outside the repository, so memory creates no project-file churn. Session custom entries store only the selected memory branch.
- The complete bounded snapshot is injected as stable context. Dynamic per-turn search/retrieval is intentionally avoided because it would mutate prompt context and weaken cache stability.
- A cross-process lock serializes every read-modify-write operation; Pi’s process-local mutation queue is therefore not the concurrency boundary.
- Gang/pi-subagents child agents are memory-isolated. When `PI_SUBAGENT_CHILD_AGENT` or `PI_SUBAGENT_RUN_ID` is present, No Forgetti does not register its tool, load memory, inject context, count turns, or run review. Only the primary/superintendent session learns and writes project memory.

## Install

No Forgetti is currently hosted in a private GitHub repository. Your GitHub account needs access before Git can install it.

### HTTPS install (recommended)

Wire GitHub CLI authentication into Git once:

```bash
gh auth login
gh auth setup-git
```

Then install globally for all Pi projects:

```bash
pi install https://github.com/Jeecabs/no-forgetti
pi list
```

Restart Pi after the first install, or run `/reload` in an existing interactive session.

### Project-local install

Write the package to the current project's `.pi/settings.json` instead of global settings:

```bash
pi install -l https://github.com/Jeecabs/no-forgetti
```

### Try without installing

Load a temporary HTTPS checkout for one Pi process without changing settings:

```bash
pi -e https://github.com/Jeecabs/no-forgetti
```

### Git shorthand

Pi also accepts its GitHub shorthand:

```bash
pi install git:github.com/Jeecabs/no-forgetti
```

### Local development

```bash
git clone https://github.com/Jeecabs/no-forgetti.git
cd no-forgetti
pnpm install
pnpm check
pnpm test
pi -e .
```

A local `pi install .` references the checkout in place, so do not move or delete it:

```bash
pi install .
```

## Model tool

`project_memory` supports:

- `list`
- `add(content)`
- `replace(oldText, content)`
- `remove(oldText)`

`oldText` is a unique substring, not an entry ID. Memory is a fixed evolving state bounded to 2,200 total characters and 800 characters per entry. Exact duplicates are ignored. Review changes apply as one atomic batch against the final size, allowing stale entries to be removed or merged before better facts are added. One bounded pre-review snapshot supports `/memory undo`; it is replaced by the next automatic review that changes memory. Entries record whether their latest write came from the foreground assistant tool or autonomous background review. Obvious secrets, fence injection, invisible Unicode controls, and prompt-manipulation entries are rejected. Automatic review sees tool names and success/failure state, not raw untrusted tool arguments/results. Expanded Pi skill bodies are removed from review evidence while the user’s trailing skill task remains.

## Commands

```text
/memory status
/memory show
/memory branches
/memory fork experiment
/memory use main
/memory refresh
/memory review
/memory undo
```

### Fork semantics

```text
project main memory ─────────────── shared by normal/new/forked Pi sessions
         │
         └─ /memory fork experiment ─ independent copy for this session
```

A Pi session fork inherits the current memory selection because that selection is stored as a branch-aware custom session entry. It still points to the same project-memory branch. Only `/memory fork` creates another memory file.

## Storage

Data stays outside the repository:

```text
$PI_CODING_AGENT_DIR/no-forgetti/<sha256(project-root)>/
├── project.json
├── reviews/
│   ├── main.json
│   └── experiment.json
├── revisions/
│   └── main.json
└── branches/
    ├── main.json
    └── experiment.json
```

`PI_CODING_AGENT_DIR` defaults to `~/.pi/agent` and supports `~/...` values.

Projects and directories are treated as trusted by default, so memory initializes immediately. Corrupt, unsupported, or oversized JSON is never silently overwritten; No Forgetti disables itself for that project and surfaces the storage error instead of injecting questionable memory. Git worktrees intentionally get separate memory because their canonical working-tree roots differ. This keeps experimental worktree conventions isolated unless you explicitly copy them.

## What belongs in memory

Good:

- durable project conventions
- architecture facts that are expensive to rediscover
- canonical verification commands
- recurring user preferences for this project
- stable non-obvious workflows and tool quirks

Bad:

- task progress or completed-work diaries
- issue/PR numbers and commit hashes
- raw logs/tool output
- temporary failures
- secrets
- facts already present in `AGENTS.md` or checked-in docs

## Cache behavior

`before_agent_start` appends the same frozen memory block each turn. `project_memory` writes update disk and live tool responses but do not mutate that snapshot. This preserves a stable prompt prefix. `/memory refresh`, `/memory use`, and `/memory fork` are explicit cache-invalidating choices.

## Development

```bash
pnpm check
pnpm test
```
