# Changelog

## Unreleased

- Apply reviewer project-skill patches automatically with a one-line receipt, and replace the approval queue for them with `/project-skills undo <name>`, which shows a rendered diff and refuses once the skill has changed again. Archives still require explicit approval.
- Drop the confirmation step from `/project-skills edit`; the editor saves straight through and the notify names the undo command.
- Address pending proposals by skill name (`/project-skills approve verification`); proposal ids still resolve, and argument completions are now fuzzy-matched rather than prefix-matched.
- Set a 6,000-character hard limit, a 4,500-character review target, and a lossless 4,000-character maintenance goal.
- Give low-headroom reviewers an exact budget. Reject invalid proposals before admission so bounded retries retain their evidence.
- Fence external review on worker memory-policy provenance. Preserve unqueued evidence when a worker needs restart.
- Honor stricter capacity from older producers during admission.
- Safely no-op capacity-violating review proposals instead of surfacing a repeating failure.
- Stop rendering redundant project-skill invocation receipts in chat history while retaining hidden usage provenance for refinement and retention.

## 0.3.0 - 2026-07-27

- **Breaking:** publish external project skills through Pi native discovery and `/skill:<name>` invocation; remove the custom `project_skill` tool and per-turn lexical body injection, then track successful native reads/invocations for refinement and retention.
- Add filesystem-authoritative per-provider attempt accounting with conservative holds, exact settlement, unknown exposure, global attempt identities, legacy-budget migration, orphan recovery, and durable retry backoff.
- Checkpoint and elect normalized provider results before memory admission so restarts reuse the same proposal without another provider call.
- Add recoverable project admission intents spanning branch mutation and revision publication, outcome-bound immutable receipts, intent compaction, and real-process crash tests.
- Fence memory and project-skill review cadence settlement so concurrent activity recorded after a review snapshot is preserved.
- Expand the SQLite observational ledger and `/memory status` with settled, held, and unknown attempt visibility.
- Redraw the `/memory status` monitor as a closed card: four-sided frame so it no longer dissolves into the editor behind it, sentence-case labels, aligned budget columns with full-width bars, and inline notices instead of a highlighted banner.
- Give embedded reviews two minutes to finish; harden project-skill reviews with enforced aborts, an explicit atomic admission commit point, truthful retry messaging, and silent lifecycle cancellation.
- Migrate project-skill cadence state to fenced claims so forced reviews cannot bypass live leases and stale workers cannot settle newer work.

## 0.2.0 - 2026-07-26

- **Breaking:** add embedded, shadow, and opt-in external memory-review authority modes.
- Add a separately runnable `no-forgetti review --once` worker and durable local review spool with deterministic jobs, fenced leases, crash recovery, strict schemas, redaction, usage/cost provenance, and daily budgets.
- Add an in-Pi `/memory status` monitor for worker heartbeat, queue depth, daily call/token/cost usage, and visible exhaustion warnings; default reviewer call budget is 100/day.
- Add an optional SQLite WAL shadow ledger for jobs, attempts, and outcomes; existing project JSON remains canonical.
- Add dedicated persistent reviewer profiles without placing credentials in jobs, logs, or outcomes.
- Add proposal-only tool-less external review plus CAS-guarded JSON admission, immutable receipts, stale rejection, and next-session review-job provenance.
- Fix bounded review coverage to process oldest unreviewed turns and advance only through included evidence.
- Add exact memory branch/entry digests, stale-plan CAS, bounded pre-parse reads, append-only review history, and inverse-CAS undo that preserves unrelated later writes.
- Keep 4,000 characters as the hard limit while making the 3,000-character working target advisory; safe no-op reviews no longer fail or force semantic loss.
- Add sanitized append-graph capture primitives and typed evidence/claim/projection policy foundations for future trajectory intelligence.
- Add compatibility shims for persisted legacy tool arguments and document the external curator, backfill, privacy, and memory-science architecture.
- Expand project memory's hard limit from 2,200 to 4,000 characters.
- Apply validated embedded memory review batches automatically; remove obsolete memory pending/approval commands.
- Reload active project memory at every turn boundary so foreground writes and accepted refinements require no manual refresh.
- Add roll-forward high/normal/low memory importance with explicit assessment provenance and ID-targeted merge/assessment operations.

## 0.1.0 - 2026-07-15

- Add project-scoped bounded memory.
- Add frozen system-prompt snapshot injection with refresh at Pi compaction boundaries.
- Add explicit memory branching without automatic session-fork cloning.
- Add end-of-turn signal scoring, periodic fallback, retry backoff, and reviewable self-learning proposals.
- Keep memory as a fixed 2,200-character evolving state with atomic consolidation batches.
- Add atomic writes, cross-process lock leases, secret checks, and tests.
- Require explicit approval for background memory mutations and generated skill creates, patches, and archives.
- Track skill recalls across distinct project sessions and report usage frequency.
- Stage reviewable archive proposals after 20 inactive sessions; cancel them when recalled.
- Harden transient skill injection across transformed prompts and tool-loop model calls.
- Validate persisted review/activity state strictly and recover stale locks without evicting live owners.
- Add HTTPS Git install docs, CI, security guidance, contribution docs, and project branding.
