# Changelog

## 0.1.0

- Add project-scoped bounded memory.
- Add frozen system-prompt snapshot injection with refresh at Pi compaction boundaries.
- Add explicit memory branching without automatic session-fork cloning.
- Add end-of-turn signal scoring, periodic fallback, retry backoff, and on-demand self-learning review.
- Keep memory as a fixed 2,200-character evolving state with atomic consolidation batches.
- Add atomic writes, cross-process lock leases, secret checks, and tests.
