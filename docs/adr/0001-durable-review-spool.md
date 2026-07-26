# ADR 0001: Durable explicit review spool

- Status: accepted; durability model amended
- Date: 2026-07-26

## Context

In-process reviews start after `agent_settled` but are aborted during `session_shutdown`. Project review cadence is shared while evidence cursors are session-local. A global Pi-session watcher cannot reliably determine settlement, active leaf, memory branch, child-agent isolation, or ephemeral history.

A durable job queue alone is insufficient. Provider execution is outside any local transaction: a worker can die after dispatch but before recording a response. The same crash boundary can make usage uncertain or leave a chosen proposal between provider completion and memory admission. SQLite cannot repair those boundaries if it is only a projection of filesystem work, and making two stores jointly authoritative would add an unavailable distributed transaction.

## Decision

The extension writes a deterministic, versioned, bounded, sanitized review job to a local atomic spool before returning from successful settlement. A shared `review --once` engine processes the same job format manually or from a separately managed user daemon. A socket may wake the daemon but is never the sole durability source. The daemon never edits Pi session files.

The local filesystem is authoritative for queue ownership and per-provider-attempt accounting. Attempts progress monotonically through `reserved`, `dispatched`, and `settled`, or terminate as `cancelled`; recovery classifies dispatch without a trustworthy durable result as `unknown`. `cancelled` requires proof that dispatch did not occur. Process memory and SQLite never downgrade `dispatched` to `reserved` or infer cancellation.

Budget authority records three classes: provider-reported `actual`, conservative live `held`, and ambiguous `unknown`. New work is admitted against their sum. Only proved pre-dispatch cancellation releases a reservation; an ambiguous dispatched call retains conservative exposure. One call may cross token or cost limits before exact usage arrives.

Provider exactly-once execution is not promised. Provider APIs do not share No Forgetti's transaction and may not offer usable idempotency. Retrying an `unknown` attempt can duplicate execution and cost. Instead, every observed result is durably checkpointed under its attempt identity, then one immutable per-job proposal decision is elected with create-or-compare semantics. Only that complete embedded decision may enter admission; duplicate or later results remain accounted but cannot cause another mutation effect.

External project mutation begins by publishing a project-local admission intent bound to the elected outcome digest and containing pre/post branch digests, frozen post-state, revision (when present), and stable receipt metadata. The full elected job/outcome remains in the global decision checkpoint. Recovery rolls forward `branch → revision → project completion → immutable receipt`, accepts exact matches, and fails closed on conflicts. It never rolls canonical memory backward. Once the bound receipt is durable, the full intent is compacted to a small immutable tombstone.

Locks remain local to one authority domain. Code must not hold spool, attempt/decision, budget, or project-memory locks while acquiring another. Durable hand-off records, immutable identity bindings, and CAS replace nested/global locks.

SQLite remains a best-effort audit/observability shadow. A later SQLite-authority phase requires an explicit ADR, migration, compatibility window, and rollback; the existence of a ledger file does not promote it.

Once enqueue is durably accepted in external authority mode, only the service may review that event. Foreground memory commands remain immediate through existing canonical JSON. External authority is enabled only after shadow-mode crash, contention, accounting, and admission gates pass.

## Durability assumptions

This decision assumes one host and a local filesystem with atomic same-filesystem publication, exclusive creation, reliable file `fsync`, and parent-directory sync. Network/cloud-synced filesystems, shared multi-host spools, cross-device moves, and storage that acknowledges flushes before stability are unsupported. Without working directory sync, No Forgetti can claim process-crash atomicity but not power-loss durability.

## Consequences

- Accepted review work survives Pi shutdown under stated filesystem assumptions.
- Duplicate job delivery and duplicate provider execution are possible; duplicate memory effects are fenced.
- Crash recovery preserves uncertainty instead of undercounting usage or silently freeing a possibly spent call.
- Durable provider results and decisions remove the need to repeat a known completed call after restart.
- Begun project admission is recoverable by deterministic roll-forward.
- Evidence, result checkpoints, decisions, and intents are persistent sensitive data requiring restrictive permissions, bounded reads, TTL/retention, and explicit deletion documentation.
- Provider credentials come from a dedicated persistent reviewer profile, never job payloads.
- Service management, protocol compatibility, budgets, reconciliation, filesystem support, and crash recovery become product responsibilities.
- Kill before `agent_settled` and killed ephemeral sessions remain outside the guarantee.

## Rejected alternatives

- Extension child process: either dies with Pi or becomes an unmanaged daemon.
- Global session watcher: cannot establish authoritative settlement or branch binding.
- Socket-only delivery: connection failure loses accepted work.
- Job lease as provider exactly-once fence: provider execution can outlive or bypass local lease publication.
- Release every orphaned reservation: undercounts calls that may have dispatched.
- SQLite plus filesystem dual authority: requires atomic commitment across independent stores and creates split-brain recovery.
- Nested/global locks: create lock-order deadlocks and still cannot include provider execution in the critical section.
- Rollback after partial project admission: can overwrite valid concurrent foreground memory; deterministic roll-forward is safer.
- Default historical scan: unexpected privacy, cost, and resource expansion.
