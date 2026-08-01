# Storage reference

No Forgetti keeps durable state outside the repository.

`PI_CODING_AGENT_DIR` defaults to `~/.pi/agent` and supports `~/…` values. Resolve the default safely in shell scripts:

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
```

## Directory layout

```text
$PI_CODING_AGENT_DIR/no-forgetti/
├── service.json                         # optional reviewer profile; never credentials
├── review-budget.json                   # legacy aggregate, imported conservatively
├── review-workers/                      # worker heartbeats for /memory status
├── review-ledger.sqlite                 # observational WAL shadow
├── review-spool/
│   ├── queued/
│   ├── running/
│   ├── outcomes/
│   ├── dead-letter/
│   ├── accounting/
│   │   ├── days/                        # actual, held, and unknown usage
│   │   └── identities/                  # immutable attempt identities
│   ├── provider-results/                # normalized per-attempt checkpoints
│   └── proposal-decisions/              # one elected result per job
└── <sha256(project-root)>/
    ├── project.json
    ├── reviews/
    │   ├── main.json
    │   └── experiment.json
    ├── revisions/
    │   └── main/
    │       ├── 000000000001-<revision-id>.json
    │       └── 000000000002-<undo-id>.json
    ├── branches/
    │   ├── main.json
    │   └── experiment.json
    ├── skills/
    │   ├── <skill-name>/
    │   │   ├── SKILL.md
    │   │   └── review.json              # latest background authorship receipt, when present
    │   └── .archive/
    ├── skill-activity-index/
    │   ├── state.json
    │   ├── sessions/<hashed-session-id>.json
    │   └── generations/<generation-id>.json
    ├── skill-review.json                 # v3 session-scoped exact cadence and lease
    ├── skill-pending/                    # bound proposals and reviewer receipts
    ├── skill-revisions/                  # frozen skill snapshots and patch receipts
    ├── service/
    │   ├── commit-receipts/
    │   └── review-feedback/
    │       ├── pending/
    │       └── ready/
    └── review-admissions/                # active intents, then compact tombstones
```

## Authority

The filesystem is authoritative for the review queue, provider attempts, budgets, decisions, and canonical project memory. SQLite is an observational ledger for status and inspection. It is not queue or memory authority.

A cross-process lock serializes project-memory read-modify-write operations. External admission also uses durable project intents and exact compare-and-swap checks.

## Permissions and sensitivity

Service configuration never contains credentials. Provider authentication stays in Pi’s `auth.json` or the worker process environment.

No Forgetti sanitizes queued evidence, but review spool and project service records remain sensitive. Result checkpoints can include sanitized jobs and model proposals. Active admission intents can include frozen memory post-state. Project-skill receipts contain job, prompt, attempt, operation, and target-binding digests.

Receipts also contain requested and observed model identities, timestamps, token usage, and cost. They do not contain raw model output or resolved credentials. Keep the whole agent directory private to your user.

## Retention and deletion

The worker periodically enforces `evidenceTtlHours` for terminal spool records, decisions, and closed-day accounting. Unresolved attempts and incomplete admission intents can remain longer for safe recovery and conservative accounting.

Stop every external worker before removing review state. Deleting unresolved state abandons recovery guarantees. See the complete procedure and threat model in [SECURITY.md](https://github.com/Jeecabs/no-forgetti/blob/main/SECURITY.md).

## Legacy state

No Forgetti migrates legacy `skill-activity.json` once into bounded per-session and per-generation records. It retains the old file as `skill-activity.json.legacy`.

Project-skill cadence migrates from versions 1 and 2 to version 3. Migration preserves global failure backoff and claim generation. It discards unattributed pending counters because it cannot assign them safely to a session path.
