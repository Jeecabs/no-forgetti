# External curator architecture

## Goal

Make accepted memory reviews survive the Pi process while preserving No Forgetti's bounded context, local-first privacy, immediate foreground memory writes, and project isolation.

The guarantee is deliberately narrow:

> A successfully settled turn that is durably accepted as a review job remains eligible for eventual review, subject to configured credentials and budgets.

This does not guarantee capture before `agent_settled`, recovery of killed ephemeral sessions, correctness of model output, or automatic historical import.

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
  ├─ durable queue / attempt ledger
  ├─ dedicated reviewer profile and budgets
  ├─ tool-less proposal generation
  ├─ deterministic proposal admission
  ├─ branch-file and entry digest CAS
  └─ immutable outcomes and mutation receipts
```

The extension remains the Pi lifecycle adapter. The service never edits Pi JSONL. Existing memory JSON remains canonical during the mixed-version release. SQLite may own jobs and receipts, but not memory, until an explicit later migration.

## Authority modes

- `embedded`: current in-process reviewer owns review.
- `shadow`: embedded reviewer remains authoritative; durable service validates transport, dedupe, plans, and outcomes without a second mutation.
- `external`: accepted jobs belong only to the service. The embedded reviewer does not process them.

Foreground `project_memory` writes remain extension-local in all initial modes. A delayed service proposal must compare against the exact current branch and entry digests.

## Review job

A job contains versioned, bounded, sanitized evidence; project and branch identity; hashed session identity; exact processed frontier; base branch digest; reason; and deterministic content digest. It never contains provider credentials.

Job effects are idempotent even though provider calls cannot be exactly-once:

```text
queued → running → plan-validated → succeeded | noop | rejected
                    └────────────→ retry | dead-letter
```

A validated plan is persisted before mutation. Mutation receipts recover the crash window after branch write and before job acknowledgement.

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

Evidence files use `0600`; containing directories use `0700`. Evidence expires after a configured terminal-job TTL. Logs contain IDs, sizes, digests, outcomes, usage, and cost—never evidence or credentials.

## Credentials and cost

External authority requires a dedicated reviewer profile. The service resolves persistent Pi credentials from the normal agent directory; jobs never copy resolved secrets. Missing auth blocks a job until configuration changes.

Per-job and daily call, token, cost, time, and queue limits fail closed. The reviewer profile never silently inherits whichever foreground model happened to be active.

## Mutation safety

Reviewers return proposals only. Admission re-runs schema, secret, Unicode, fence, duplicate, capacity, evidence-reference, and target-precondition checks.

During v1 coexistence, CAS uses exact canonical branch-file bytes and expected entry digests stored in sidecars. Unknown revision fields are not added to v1 branch JSON because old clients may reconstruct and drop them.

Undo is an inverse commit guarded by expected head. It also fences older queued jobs so undone evidence cannot immediately reapply the same mutation.

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
3. Durable spool and shadow ledger with crash injection.
4. Opt-in JSON-authority memory daemon.
5. Append-graph/evidence intelligence in shadow.
6. Scoped agent reviewer, skills, database authority, Codex, and backfill as separate gates.

Hard gates include zero secret leakage, zero duplicate mutation effects, exact rollback digests, bounded resource/cost behavior, and memory precision calibrated against a frozen baseline.
