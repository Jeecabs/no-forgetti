# Security policy

## Reporting

Please report vulnerabilities through GitHub's **Security → Report a vulnerability** flow. Do not open a public issue for undisclosed vulnerabilities.

Include the affected version, impact, reproduction steps, and any suggested mitigation. You should receive an acknowledgement within seven days.

## Security model

No Forgetti is a Pi extension and therefore runs with the same filesystem, process, and network permissions as Pi. Review the source before installation.

Project memory and generated skill state stay under `$PI_CODING_AGENT_DIR/no-forgetti/` by default. Embedded background reviews call the active model provider. Opt-in external review uses a dedicated persistent reviewer profile and a local durable spool; jobs never contain resolved credentials, thinking, images, raw tool arguments/results, user bash, provider headers, or diagnostics. Evidence is bounded to 32,000 sanitized characters and stored with restrictive permissions.

External durability persists more than queued evidence. Per-attempt state, provider-result checkpoints, elected proposal decisions, budget accounting, outcomes, and active project admission intents persist sensitive material. Result/decision checkpoints embed sanitized jobs and proposals; active admission intents embed frozen memory post-state. Treat all of them as sensitive even though they exclude resolved credentials. Completed admission intents compact to digest-only tombstones after receipt durability. Terminal spool, decision, and closed-day accounting retention is enforced periodically while the worker runs. Unresolved attempts and incomplete admission intents remain longer for safe recovery and conservative cost accounting; admission receipt completion compacts full project post-state. To forget review evidence, stop every worker first, then remove `$PI_CODING_AGENT_DIR/no-forgetti/review-spool/`, `$PI_CODING_AGENT_DIR/no-forgetti/review-budget.json*`, `$PI_CODING_AGENT_DIR/no-forgetti/review-ledger.sqlite*`, and relevant per-project `service/` records. Deleting unresolved attempt, decision, budget, or admission state abandons recovery/accounting guarantees. SQLite secure deletion and WAL truncation apply to the observational ledger during normal retention, but SQLite is not queue, attempt, budget, decision, or memory authority.

Provider exactly-once execution is not a security or billing guarantee. A crash after dispatch can leave an `unknown` attempt; retry may duplicate provider execution and cost. No Forgetti retains conservative `unknown` budget exposure rather than claiming the call was cancelled. Proposal-decision and exact-CAS fencing prevent a duplicate provider result from becoming a duplicate memory effect.

The external worker is separately managed and does not start during installation. Its first release is tool-less: no shell, project filesystem, generic read/write, or network tools are exposed to conversation evidence. Existing project JSON remains canonical; proposals pass the same validators and compare-and-swap checks before mutation. A begun external mutation uses a durable project admission intent and deterministic roll-forward; conflicts fail closed. Validated live memory refinements may apply automatically; skill review remains in Pi, with patches and archives requiring explicit approval. Memory keeps an append-only review/undo journal, and undo refuses to overwrite conflicting later writes.

Durability assumes one host and a trustworthy local filesystem with atomic same-filesystem publication plus working file and parent-directory `fsync`. Do not place No Forgetti state on NFS, a cloud-synced directory, shared multi-host storage, or media with weak flush semantics. No subsystem may hold a spool, attempt/decision, budget, or project-memory lock while acquiring another; report lock-order violations as reliability/security defects.

Only the latest release and current `main` branch receive security fixes.
