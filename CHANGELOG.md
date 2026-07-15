# Changelog

## Unreleased

- Expand project memory's hard limit from 2,200 to 4,000 characters.
- Start review-driven refinement at a 3,000-character working target and give the reviewer exact capacity guidance.

## 0.1.0 — 2026-07-15

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
