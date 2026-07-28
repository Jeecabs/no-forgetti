<p align="center">
  <img src="assets/no-forgetti-logo.jpg" alt="No Forgetti elephant logo" width="240">
</p>

<h1 align="center">No Forgetti</h1>

<p align="center">Project-scoped persistent memory and self-forming skills for Pi.</p>

No Forgetti ports the useful part of [Hermes Agent](https://github.com/NousResearch/hermes-agent)'s learning loop without turning Pi sessions into one global memory stream.

## Behavior

- Memory scope = nearest Git root; when no Git root exists, exact launch directory.
- Pi `/fork` and `/clone` keep using the same memory branch. They **do not** clone memory automatically.
- `/memory fork <name>` explicitly clones the active memory and switches only the current Pi session to it. With Pi session persistence disabled, that selection lasts only for the current process.
- Writes persist immediately. Every turn reloads and injects the active memory branch, so foreground tools, background review, and other sessions become visible without `/memory refresh`.
- External admissions also publish durable UI feedback. An open Pi picks it up on the service-monitor tick; if Pi is closed, the next project session consumes it. Applied reviews render the actual committed content as `+` additions, `~` replacements, and `-` removals rather than summarizing the model proposal.
- Review starts only after Pi is fully settled at the end of a completed turn. The default `embedded` mode preserves in-process review; `shadow` durably mirrors bounded sanitized jobs; opt-in `external` authority hands accepted jobs to the separately runnable No Forgetti worker so Pi shutdown does not abort them. Review processes the oldest bounded unreviewed window and advances only through included evidence, preventing truncation from skipping history. Validated changes use branch compare-and-swap, append-only history, and inverse-CAS `/memory undo` that refuses to erase later conflicting writes. Explicit signals trigger early review; 10 completed prompts remain the periodic fallback. `/memory review` and `/project-skills review` run on demand.
- Successful complex workflows can form an external project skill. Validated new skills and patches are applied automatically and reverted with `/project-skills undo <name>`; only archives stay pending until you inspect and approve them. Skills stay in No Forgetti storage, are published through Pi's native skill discovery, support `/skill:<name>`, and are never written into the repository.

## Design boundary

- **Learning** happens only after a successfully completed turn: apply compact additions, replacements, or removals from recent conversation evidence.
- **Maintenance** happens inside the same atomic mutation. Reviews can grow memory to the 4,500-character working target. Near that target, the reviewer receives the exact remaining budget. New facts must fit or include safe consolidation. Full memory cannot grow, and lossless maintenance aims for 4,000 characters. The 6,000-character hard limit reserves 1,500 characters for foreground writes.
- A separately managed curator is optional. When enabled, it owns accepted background review jobs, model calls, retries, budgets, outcomes, and CAS admission; foreground `project_memory` writes remain immediate through the canonical JSON store. Project skills retain their separate approval, revision, usage, and retention semantics and are not processed by the first external memory-review release.
- Project-skill lifecycle belongs to No Forgetti; invocation belongs to Pi. No Forgetti publishes its active external `skills/` directory through `resources_discover`; `/project-skills` remains the management surface.
- Durable state intentionally lives outside the repository, so memory creates no project-file churn. Session custom entries store only the selected memory branch.
- The complete bounded memory snapshot is injected as stable context. Project skills use Pi's progressive disclosure: compact metadata stays in the system prompt, and a body enters conversation context only when Pi reads or explicitly invokes that skill.
- A cross-process lock serializes every read-modify-write operation; Pi’s process-local mutation queue is therefore not the concurrency boundary.
- Gang/pi-subagents child agents are memory-isolated. When `PI_SUBAGENT_CHILD_AGENT` or `PI_SUBAGENT_RUN_ID` is present, No Forgetti does not register its tool, load memory, inject context, count turns, or run review. Only the primary/superintendent session learns and writes project memory.

## Install

### HTTPS install (recommended)

Install globally for all Pi projects:

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

## External review service (opt-in)

No Forgetti never starts a daemon during package installation. Configure a dedicated reviewer profile in `$PI_CODING_AGENT_DIR/no-forgetti/service.json`; credentials remain in Pi's normal `auth.json` or environment and are never copied into jobs:

```json
{
  "version": 1,
  "mode": "external",
  "evidenceTtlHours": 24,
  "reviewer": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "reasoningEffort": "high",
    "maxCallsPerDay": 100,
    "maxTokensPerDay": 500000,
    "maxCostPerDayUsd": 10
  }
}
```

Modes:

- `embedded` (default): Pi performs review in process.
- `shadow`: Pi remains authoritative and also writes deterministic sanitized jobs for transport/eval inspection.
- `external`: Pi durably queues the job and the service owns its eventual model call and CAS admission.

Daily calls are reserved atomically. Token and cost thresholds use actual provider usage, so one in-flight call may cross a threshold; subsequent calls stop until the next UTC day. `/memory status` makes this visible inside Pi.

Run queued work once:

```bash
no-forgetti review --once
```

Run the polling worker under your user service manager (`launchd`, `systemd --user`, or equivalent). Once registered, it starts automatically and `/memory status` shows worker health, queue depth, and daily call/token/cost limits:

```bash
no-forgetti review
```

See [external review service management](docs/service-management.md) for concrete `launchd` and `systemd --user` registration. After registration, `/memory status` is the in-Pi operational monitor.

The first external release processes memory review only. It does not run project-skill review, scan historical Pi sessions, or expose coding tools. The worker must be registered once with the operating system's user service manager; after that it starts automatically rather than waiting for a Pi command. Accepted evidence remains bounded to 12 user turns / 32,000 characters and excludes thinking, images, raw tool arguments/results, and user bash.

## Model tool

`project_memory` supports:

- `list`
- `add(content, importance?)`
- `replace(oldText, content, importance?)`
- `remove(oldText)`

`oldText` is a unique substring used by the foreground model tool. Background reviews target existing entries by stable ID. They can add, replace, remove, merge, or assess entries. Memory has four bounds: a 4,000-character maintenance goal, a 4,500-character review target, a 6,000-character hard limit, and 800 characters per entry. Exact duplicates are ignored. Reviews below the target cannot cross it. Reviews at or above the target cannot grow memory. The external engine rejects an invalid proposal before admission. Its evidence stays in the spool during bounded retries. Canonical admission still safely skips any invalid proposal that reaches it. Accepted changes form one atomic batch against final hard capacity and an exact base-branch digest.

Importance is `high`, `normal`, or `low` and measures cost of forgetting—not truth or recency. Existing entries roll forward as effective `normal` but remain visibly unassessed. New additions can be assessed immediately; background reviews reassess replacements and merges and can gradually assess untouched legacy entries when evidence supports it. Semantic invalidity wins over importance: contradicted or documented facts can always be removed. Changed automatic reviews and undo operations append immutable revision records. `/memory undo` creates an inverse-CAS revision and refuses to overwrite a reviewed entry changed later; unrelated later additions survive. Each entry also stores creation/update timestamps, source session, and whether its first/latest write came from the foreground assistant tool or background review. Because the complete branch is injected every turn, per-entry exposure tracking adds no use signal: every active entry is exposed. Obvious secrets, fence injection, invisible Unicode controls, and prompt-manipulation entries are rejected. Automatic review sees tool names and success/failure state, not raw untrusted tool arguments/results. Expanded Pi skill bodies are removed from review evidence while the user’s trailing skill task remains.

## Commands

```text
/memory status
/memory show
/memory branches
/memory fork experiment
/memory use main
/memory review
/memory undo

/project-skills list
/project-skills stats
/project-skills read <name>
/project-skills edit <name>
/project-skills undo <name>
/project-skills pending
/project-skills approve <name>
/project-skills reject <name>
/project-skills review
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
$PI_CODING_AGENT_DIR/no-forgetti/
├── service.json                         # optional reviewer profile; never credentials
├── review-budget.json                    # legacy daily aggregate, imported conservatively
├── review-workers/                       # per-worker heartbeats for /memory status
├── review-ledger.sqlite                  # optional observational WAL shadow
├── review-spool/
│   ├── queued/
│   ├── running/
│   ├── outcomes/
│   ├── dead-letter/
│   ├── accounting/
│   │   ├── days/                         # actual, held, and unknown usage
│   │   └── identities/                   # global immutable attempt identities
│   ├── provider-results/                 # per-attempt normalized checkpoints
│   └── proposal-decisions/               # one elected result per job
└── <sha256(project-root)>/
    ├── project.json
    ├── reviews/
    │   ├── main.json
    │   └── experiment.json
    ├── revisions/
    │   └── main/
    │       ├── 000000000001-<revision-id>.json
    │       └── 000000000002-<undo-id>.json
    ├── skills/
    │   ├── <skill-name>/SKILL.md
    │   └── .archive/
    ├── skill-activity-index/
    │   ├── state.json
    │   ├── sessions/<hashed-session-id>.json
    │   └── generations/<generation-id>.json
    ├── skill-pending/
    ├── skill-revisions/
    ├── service/
    │   ├── commit-receipts/
    │   └── review-feedback/
    │       ├── pending/                   # registered Pi UI deliveries
    │       └── ready/                     # admitted content diffs awaiting Pi
    ├── review-admissions/                 # active intents, then compact tombstones
    └── branches/
        ├── main.json
        └── experiment.json
```

`PI_CODING_AGENT_DIR` defaults to `~/.pi/agent` and supports `~/...` values. Legacy `skill-activity.json` data migrates once into bounded per-session/per-generation records and is retained as `skill-activity.json.legacy`. Project skills use standard `SKILL.md` packages in the same external project directory. No Forgetti gives Pi the active `skills/` path through `resources_discover`, so generated skills participate in native discovery and `/skill:<name>` invocation without moving into the repository.

## Project skills

Project skills are procedural memory formed from durable, repeatable workflows. The reviewer follows `writing-great-skills`: concise trigger descriptions, checkable completion criteria, progressive disclosure, one source of truth, and aggressive pruning of duplication/no-op prose.

The background reviewer produces at most one create/patch/archive operation per review. Validated creates and patches are applied automatically: a patch fails closed unless its anchor text matches exactly once, snapshots a revision first, and is reverted with `/project-skills undo <name>`, which shows the rendered diff in its confirmation. A patch whose anchor no longer matches falls back to the pending queue. On startup, No Forgetti also applies valid create proposals left pending by older versions; conflicts remain pending rather than being guessed through. Archives remain pending because archiving is the only operation that removes a skill from discovery; inspect them with `/project-skills pending`, then approve or reject them by skill name. `/project-skills` opens a theme-aware interactive browser in TUI mode. The browser focuses on active skills: select by name and trigger description, inspect session/recall activity, read Markdown with keyboard paging, traverse directly with `[`/`]`, and edit with `e`; `e` opens the built-in multiline editor and saves a revision on exit. `/project-skills stats` reports recall frequency and inactivity across distinct project sessions.

Pi exposes active project-skill names, trigger descriptions, and paths in its native `<available_skills>` system-prompt section. When a task matches, the model reads the package's `SKILL.md`; users can force the same native path with `/skill:<name>`. Use `/project-skills` for list/read access and stats, edits, or pending proposals. Pi refreshes skill additions and archives after `/reload` or the next session.

No Forgetti observes successful native `read` results for active project `SKILL.md` paths and persisted native `/skill:<name>` expansion messages. Observed uses are credited only after the agent run settles successfully, before skill review and retention run; duplicate observations of one skill in the same run count once. Each credited run appends hidden custom session provenance containing the validated skill names. It stays out of the working agent context and chat transcript while remaining available to bounded review evidence. Recall tracking stays local and retains bounded SHA-256 session markers solely to de-duplicate distinct-session usage; raw Pi session identifiers are not stored and No Forgetti sends no telemetry. These durable use signals feed background refinement and retention. After 20 completed distinct project sessions without recall, No Forgetti stages an archive proposal when the threshold-crossing session settles. Recalling the skill withdraws its automatic retention proposal; rejecting it snoozes retention for another 20 sessions. Culling never deletes or archives without explicit approval. Skills remain external to the repository.

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

`before_agent_start` reloads the active memory branch and appends its complete block each turn. Project skills do not use a No Forgetti `context` hook: Pi owns their metadata prompt, native invocation messages, and on-demand `read` results. `project_memory` writes and automatic review update disk immediately; the next turn picks them up automatically. `/memory use` and `/memory fork` switch which live branch the session reads.

## Security and contributing

No Forgetti runs with Pi's full system permissions. Background reviews make extra calls to your configured model provider using bounded, sanitized conversation evidence. Review [SECURITY.md](SECURITY.md) before installation and report vulnerabilities privately. Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Upstream inspiration is noted in [NOTICE.md](NOTICE.md).

## Development

```bash
pnpm check
pnpm test
```
