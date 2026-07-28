# External curator architecture

## Goal

Make accepted memory reviews survive the Pi process while preserving No Forgetti's bounded context, local-first privacy, immediate foreground memory writes, and project isolation.

The guarantee is deliberately narrow:

> A successfully settled turn that is durably accepted as a review job remains eligible for eventual review, subject to configured credentials and budgets.

This does not guarantee capture before `agent_settled`, recovery of killed ephemeral sessions, correctness of model output, provider exactly-once execution, or automatic historical import.

## Delivery architecture

```text
Pi extension
  ├─ injects current memory at turn boundaries
  ├─ performs immediate foreground memory commands
  ├─ sanitizes completed evidence
  └─ atomically enqueues deterministic review jobs
                  │
                  ▼
Review service
  ├─ filesystem-authoritative queue and attempt journal
  ├─ dedicated reviewer profile and durable budgets
  ├─ tool-less proposal generation
  ├─ immutable provider-result and proposal-decision checkpoints
  ├─ deterministic proposal admission
  ├─ exact branch-digest CAS and admission intent
  └─ immutable outcomes, mutation receipts, and SQLite shadow
```

The extension remains the Pi lifecycle adapter. The service never edits Pi JSONL. Existing memory JSON remains canonical during the mixed-version release. SQLite is observational shadow state, not authority for queue ownership, provider attempts, budgets, decisions, or memory.

External UI feedback uses a project-local durable mailbox. The extension registers accepted external jobs before returning to Pi. Successful admission publishes a private, bounded event containing the actual post-validation content diff before its compact receipt. An open Pi consumes ready feedback during service polling; otherwise the next project session consumes it at startup. Consumption appends the same custom transcript entry used by embedded review, then removes the pending and ready files. The card shows `+` added content, `~` replacement content with its prior value when expanded, and `-` removed content. Proposed operations never drive the card because admission may reject, stale, or partially no-op them.

## Authority modes and rollout

- `embedded`: current in-process reviewer owns review.
- `shadow`: embedded reviewer remains authoritative; durable service validates transport, dedupe, attempt accounting, decisions, and recovery without a second mutation.
- `external`: accepted jobs belong only to the service. The embedded reviewer does not process them.

Foreground `project_memory` writes remain extension-local in all initial modes. A delayed service proposal must compare its captured exact branch digest against the current branch.

Authority is staged rather than inferred from files merely existing:

1. Filesystem queue and SQLite audit shadow.
2. Per-provider-attempt journal, conservative budget accounting, and durable result/decision election in shadow.
3. Project admission intents and crash recovery in shadow.
4. Explicit opt-in external authority after crash, contention, privacy, and budget gates pass.
5. Any future SQLite or claim-store authority requires a separate migration, compatibility window, and rollback plan.

## Job and provider-attempt authority

Review jobs are versioned, bounded, sanitized, identity-bound records. Queue/running/outcome files fence job ownership. Each provider attempt also needs its own immutable filesystem identity and state; a job-level lease alone cannot account for a request that may outlive its worker.

Provider-attempt states are:

- `reserved`: budget and attempt identity durably allocated; provider dispatch not yet recorded.
- `dispatched`: the pre-dispatch checkpoint completed and provider execution may have begun.
- `settled`: a complete provider result, including normalized outcome and available provenance/usage, is durably checkpointed.
- `unknown`: dispatch may have happened, but no trustworthy durable result proves its outcome.
- `cancelled`: the reservation is durably closed with proof that dispatch did not happen.

Recovery may cancel an orphaned `reserved` attempt. It must conservatively turn an orphaned `dispatched` attempt into `unknown`; it must not pretend the call was cancelled or free its full budget. State transitions are monotonic and idempotent. Attempt files, not process memory or SQLite rows, answer whether a provider call may have occurred.

Provider APIs generally cannot participate in No Forgetti's local transaction and may not accept an idempotency key. Therefore provider exactly-once execution is impossible to promise. A worker can crash after the provider accepted a request but before the response is durable. Retrying an `unknown` attempt may make another paid call. No Forgetti instead guarantees at-most-one elected proposal effect per job: every observed result is checkpointed under its attempt identity, and one immutable proposal-decision record selects the result eligible for admission. Later or replayed results remain accounted evidence and cannot replace the elected decision.

## Durable result and decision checkpoints

A provider result is persisted before it can affect job completion or project memory. Its immutable checkpoint binds attempt ID, complete review job, normalized outcome, and proposal digest. A successful result may then create-or-compare one immutable proposal decision for the job. The decision embeds the complete elected job and outcome so recovery never needs to reconstruct the proposal or call the provider again.

Conflicting content at an existing immutable path fails closed. Failed attempts are checkpointed for accounting but cannot win proposal election. Queue outcome publication follows the durable decision; an existing matching checkpoint is replay, not new work.

## Budget accounting

Budget reporting separates certainty rather than compressing ambiguous calls into one total:

- `actual`: usage/cost from a durably settled provider result.
- `held`: conservative reservation for live or recoverable work, including a call count before dispatch and configured token/cost exposure where exact usage is unavailable.
- `unknown`: exposure from an `unknown` attempt. It remains visible and charged conservatively because the provider may have executed even though usage was not observed.

Admission checks `actual + held + unknown` against daily call, token, and cost limits before reserving another attempt. Settling moves held exposure to actual usage; proved pre-dispatch cancellation releases held exposure; ambiguous dispatch moves it to unknown. One in-flight call can exceed token or cost thresholds because exact usage is known only afterward. UTC rollover must not erase unresolved attempt accounting; unknown exposure remains attributable and visible until an explicit reconciliation policy resolves it.

The reviewer profile never silently inherits whichever foreground model happened to be active. Missing model/auth configuration before dispatch permits cancellation; provider/auth errors observed after dispatch are settled or unknown according to durable evidence, not guessed from error text.

## Project admission transaction

Reviewers return proposals only. Admission re-runs schema, secret, Unicode, fence, duplicate, capacity, evidence-reference, and target-precondition checks under canonical project-memory authority.

Before the first project mutation, admission durably publishes a project-local intent containing an exact binding to the elected outcome, base and resulting branch digests, frozen post-admission branch, optional revision, and stable receipt metadata. The complete elected job/outcome remains in the global decision checkpoint. Recovery inspects canonical artifacts and rolls the project intent forward in order:

```text
intent → branch → revision (when present) → project completion → immutable receipt
```

Matching artifacts are idempotent. Missing next artifacts are published. Conflicting artifacts fail closed; recovery never rolls the branch backward. After the bound receipt is durable, the full project intent is compacted to a digest-only tombstone. This makes the project intent the recovery authority for a begun branch mutation, while project memory JSON remains content authority and the decision checkpoint remains provider-result authority.

No nested locks are permitted across subsystems. Spool, attempt/decision, budget, and project-memory operations acquire one lock domain at a time, persist the hand-off record, release it, then enter the next domain. Recovery uses immutable identities and compare-and-swap checks rather than holding a global lock or acquiring a project lock while a spool/decision/budget lock is held.

During v1 coexistence, admission compares the exact canonical digest captured from the complete pre-sanitization branch object. Unknown revision fields are not added to v1 branch JSON because old clients may reconstruct and drop them. Undo remains entry-level inverse CAS: unrelated later writes survive, while a reviewed entry changed later refuses reversal.

## Filesystem durability assumptions

The durability model assumes one host and a trustworthy local filesystem providing atomic same-filesystem rename/link or exclusive creation, stable file handles, exclusive lock-file creation, and working `fsync`/directory-sync semantics. Durable publication means write temporary file, sync file, atomically publish, then sync its parent directory; durable deletion likewise requires parent-directory sync.

Network filesystems, cloud-synced folders, removable media with weak flush guarantees, multi-host workers sharing a spool, and filesystems that lie about flush completion are outside the guarantee. Unsupported directory sync or abrupt storage/power failure can reduce the guarantee to process-crash atomicity. The spool, decision store, budget files, admission intents, and canonical project store must stay on local storage; cross-device moves are not a transaction primitive.

## Privacy

Initial authoritative review preserves the existing evidence boundary:

- at most 12 user turns / 32,000 characters
- user and assistant text
- tool name and success/failure only
- no thinking
- no images or base64
- no raw tool arguments/results
- no user bash
- no auth, provider headers, or diagnostics

Evidence and durable checkpoints use private files and directories. Evidence expires after configured terminal-job TTL. Logs contain IDs, sizes, digests, outcomes, usage, and cost, never evidence or credentials. Result/decision checkpoints and admission intents embed sanitized jobs and proposals, so they inherit the same sensitivity and retention obligations.

## Append-graph trajectory track

Rich trajectory intelligence is separate from first authority. It incrementally sends sanitized append-order entries plus independent settled-leaf checkpoints. It never repeats root-to-leaf snapshots.

Node identity binds parent digest, canonical sanitized payload, parser version, and sanitizer version. Duplicate overlap is accepted; gaps request a bounded predecessor; missing ancestry is quarantined. Review coverage uses canonical turn/node digests rather than one cursor.

This ledger later supports evidence, claims, file applicability, selective projection, and agentic reviewers. Indexing does not imply model review.

## Historical backfill

No historical scan runs at install or daemon startup. Backfill is an explicit two-step operation:

```text
backfill plan --project <cwd> [caps]
backfill run <plan-id>
```

Plans report eligible files, provenance quality, bytes, dates, calls, tokens, cost, time, and disk growth. Import is streaming, resumable, capped, index-first, and shadow-only. Historical leaves without trusted settled checkpoints remain inferred. Legacy review cursors are uncertain coverage because old bounded reviews may have skipped earlier entries.

Canonical memory is never automatically mutated from historical backfill. Promotion requires staged diff, full pre-batch snapshot, atomic apply, audit, and exact rollback.

## Rollout gates

1. Current cursor, CAS, undo, capacity, and versioning correctness.
2. Shared `review --once` engine from a clean packed install.
3. Filesystem spool plus shadow SQLite ledger with crash injection.
4. Attempt state, actual/held/unknown budget, and decision-election recovery.
5. Project admission-intent roll-forward with no nested locks.
6. Opt-in JSON-authority memory daemon.
7. Append-graph/evidence intelligence in shadow.
8. Scoped agent reviewer, skills, future database authority, Codex, and backfill as separate gates.

Hard gates include zero secret leakage, zero duplicate mutation effects, exact decision and admission digest replay, bounded conservative cost behavior, local-filesystem fault tests, and memory precision calibrated against a frozen baseline.
