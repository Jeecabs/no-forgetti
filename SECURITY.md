# Security policy

## Reporting

Please report vulnerabilities through GitHub's **Security → Report a vulnerability** flow. Do not open a public issue for undisclosed vulnerabilities.

Include the affected version, impact, reproduction steps, and any suggested mitigation. You should receive an acknowledgement within seven days.

## Security model

No Forgetti is a Pi extension and therefore runs with the same filesystem, process, and network permissions as Pi. Review the source before installation.

Project memory and generated skill state stay under `$PI_CODING_AGENT_DIR/no-forgetti/` by default. Pi exposes active generated skill packages through native resource discovery. Validated metadata enters Pi's skill index. Validated bodies enter working context only after native `read` or `/skill:<name>` invocation.

Embedded background reviews call the active model provider. Project-skill packets never contain resolved credentials, thinking, images, raw tool arguments, or raw tool results. Packets contain at most 32,000 sanitized transcript characters. They can include bounded allowlisted command and project-path facts. The extractor rejects ambiguous call/result pairs, shell controls, mutating command forms, sensitive paths, and symlink escapes.

Project-skill jobs bind the exact packet and prompt contract with SHA-256 digests. Proposal citations must match exact transcript spans or canonical action facts. Stored receipts bind the requested profile, observed model, prompt attempts, operation, and captured target generation/content or absence. They also contain timestamps, token usage, and cost. They exclude raw model output and credentials. Invalid output, invalid admission, and runner failures do not consume the evidence frontier.

Opt-in external memory review uses a dedicated persistent reviewer profile and a local durable spool. External jobs never contain resolved credentials, thinking, images, raw tool arguments/results, user bash, provider headers, or diagnostics. No Forgetti stores evidence with restrictive permissions.

External durability persists more than queued evidence. Per-attempt state, provider-result checkpoints, proposal decisions, budgets, outcomes, and active admission intents contain sensitive material. Result and decision checkpoints embed sanitized jobs and proposals. Active admission intents embed frozen memory post-state. Treat all of them as sensitive even though they exclude resolved credentials.

Completed admission intents compact to digest-only tombstones after receipt durability. The worker periodically removes terminal spool, decision, and closed-day accounting records. Unresolved attempts and incomplete admission intents remain longer for safe recovery and conservative cost accounting. Admission receipt completion compacts full project post-state. Runtime heartbeat records also contain process IDs, release versions, and local project paths.

To forget review evidence and runtime metadata, stop every worker first. Then remove these paths:

- `$PI_CODING_AGENT_DIR/no-forgetti/review-spool/`
- `$PI_CODING_AGENT_DIR/no-forgetti/review-budget.json*`
- `$PI_CODING_AGENT_DIR/no-forgetti/review-ledger.sqlite*`
- `$PI_CODING_AGENT_DIR/no-forgetti/runtimes/`
- Relevant per-project `service/` records

Deleting unresolved state abandons recovery and accounting guarantees. SQLite secure deletion and WAL truncation apply during normal retention. SQLite is not queue, attempt, budget, decision, or memory authority.

Provider exactly-once execution is not a security or billing guarantee. A crash after dispatch can leave an `unknown` attempt. A retry can duplicate provider execution and cost. No Forgetti retains conservative `unknown` budget exposure rather than claiming cancellation. Proposal-decision and exact-CAS fencing prevent a duplicate provider result from becoming a duplicate memory effect.

The external worker is separately managed and does not start during installation. Its first release is tool-less. It exposes no shell, project filesystem, generic read/write, or network tools to conversation evidence. Existing project JSON remains canonical. Proposals pass the same validators and compare-and-swap checks before mutation.

A begun external mutation uses a durable project admission intent and deterministic roll-forward. Conflicts fail closed. Validated live memory refinements may apply automatically. Skill review remains in Pi.

Skill patches and archives require explicit approval. Memory keeps an append-only review and undo journal. Undo refuses to overwrite conflicting later writes.

The live skill-review evaluation command requires explicit `--live` consent, two reviewer profiles, and hard call, token, cost, and output limits. It does not read `service.json` or mutate project state. Failed dispatched calls retain a conservative budget reservation when actual usage is unavailable.

Durability assumes one host and a trustworthy local filesystem. The filesystem must support atomic same-filesystem publication and working `fsync`. Do not place state on NFS, cloud-synced directories, shared multi-host storage, or media with weak flush semantics. A subsystem must not hold one authority lock while it gets another. Report lock-order violations as reliability and security defects.

Only the latest release and current `main` branch receive security fixes.
