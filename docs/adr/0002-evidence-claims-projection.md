# ADR 0002: Separate evidence, claims, and projection

- Status: accepted
- Date: 2026-07-26

## Context

Current memory is a bounded free-text list edited directly from recent transcript. It cannot preserve complete provenance, contradictions, scope, freshness, or independent recurrence. Injecting every entry each turn proves exposure only and creates feedback if assistant repetitions are counted as new evidence.

## Decision

Future trajectory intelligence uses three layers:

1. immutable typed evidence with task/trajectory provenance;
2. atomic scoped claims with conflicts and independent metrics;
3. bounded runtime projection rendered from applicable active claims.

Commonness, truth/extraction/scope confidence, importance, applicability, freshness, and utility remain separate sufficient statistics. They compose only during projection selection. Memory-derived output has zero independent truth/commonness weight.

Scope has two axes: spatial locus (user/global, project, directory, file, symbol) and validity (task, time, version, environment, branch). Narrow exceptions override broad claims without deleting them.

## Consequences

- Projection can remain compact without deleting why a belief exists.
- Contradictions become contested/superseded history instead of destructive replacement.
- Consolidation must retain every atomic proposition, selector, exception, and evidence link.
- Capacity cannot force semantic loss; selective projection handles pressure.
- Claim/evidence storage and longitudinal evaluation are significantly more complex.
- Historical ingestion and cross-project/global memory require explicit privacy gates.

## Rejected alternatives

- One master memory score: collapses truth, recurrence, value, and relevance.
- Frequency as confidence: correlated retries and echoes inflate belief.
- One scope enum containing task: task validity is orthogonal to file/project locus.
- Free-text entry as source of truth: wording changes destroy semantic identity and provenance.
