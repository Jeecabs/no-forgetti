# No Forgetti domain language

## Memory

A durable belief or preference available for future work. Memory is not conversation history, task progress, or a raw observation.

## Evidence

An immutable, provenance-linked observation that may support, contradict, or qualify a claim. Evidence is never itself an instruction to the reviewer.

## Claim

An atomic semantic belief derived from evidence. A claim retains its locus, validity, confidence, freshness, importance, recurrence, conflicts, and evidence lineage independently from its rendered wording.

## Projection

The bounded text selected from active claims and presented to an agent. Projection may omit wording without deleting claims or evidence.

## Session entry graph

Append-only Pi session entries connected by parent IDs. It may contain multiple branches and does not itself prove that any branch completed successfully.

## Settled capture

A durable checkpoint sealing one root-to-leaf session path after Pi reports `agent_settled`. A settled capture includes sanitized append-only entry deltas and the selected memory branch.

## Trajectory ledger

The union of session entry graphs, settled captures, task episodes, and their provenance. It preserves branches without treating abandonment as failure.

## Task episode

One causal goal/action/outcome episode inside a trajectory. Retries, summaries, and copied fork ancestry belong to the same episode unless independent work is established.

## Commonness

Empirical recurrence conditional on detected applicable opportunities. Commonness does not measure truth, importance, freshness, or current relevance.

## Confidence

Belief that an atomic claim is true under its stated locus, conditions, and valid time. Truth, extraction, and scope confidence remain distinct.

## Importance

The asymmetric cost of forgetting a true claim. Importance does not imply that the claim is true, common, fresh, or currently applicable.

## Applicability

A runtime match between a claim selector and the current locus, task, environment, version, and valid time.

## Freshness

Whether evidence and anchors supporting a claim remain current. Non-use and elapsed time alone do not prove staleness or falsity.

## Exposure

A claim was present in an agent projection. Exposure is not evidence of retrieval, application, usefulness, or truth.

## Selection

A retriever chose a claim for a context-specific projection. Selection measures retriever behavior, not claim utility.

## Application

Observed behavior matched a claim. Attribution remains uncertain unless an external verifier or user confirms the outcome.

## Verified application

An application with external outcome evidence. It may support utility while still not independently proving claim truth.

## Locus

The spatial reach of a claim: user/global, project, directory, file, or symbol. Task validity is orthogonal to locus.

## Review job

A durable, deterministic request to refine memory from bounded sanitized evidence. Accepted jobs remain eligible for processing subject to explicit budgets and available reviewer credentials. A job is not a provider attempt.

## Provider attempt

One identity-bound opportunity to call a model provider for a review job. Filesystem state is authoritative for its accounting; SQLite may only shadow it.

## Reserved attempt

An attempt with durable identity and held budget for which provider dispatch is not yet recorded. Recovery may cancel it only while non-dispatch remains provable.

## Dispatched attempt

An attempt whose durable pre-dispatch checkpoint says provider execution may have begun. Dispatch does not prove that a response was received or billed.

## Settled attempt

An attempt with a complete durable provider-result checkpoint, including normalized outcome and any observed provenance/usage.

## Unknown attempt

A dispatched attempt without trustworthy durable proof of its provider outcome. It retains conservative budget exposure; retry can duplicate provider execution because provider exactly-once is impossible to guarantee.

## Cancelled attempt

A durably closed reservation with proof that provider dispatch did not happen. Cancellation is not a synonym for timeout, lost response, or worker death.

## Actual budget

Usage and cost supported by a settled provider result.

## Held budget

Conservative exposure reserved for live or recoverable work but not yet reconciled to actual usage.

## Unknown budget

Conservative exposure assigned to unknown attempts whose provider execution or charge cannot be disproved.

## Provider-result checkpoint

An immutable, identity-bound record of one settled attempt's complete normalized job and outcome. It is published before that result can affect memory.

## Proposal decision

The one immutable per-job election naming the provider-result checkpoint eligible for admission. Other observed results remain accounted but cannot replace it.

## Proposal

Evidence-linked typed operations returned by a reviewer. A proposal cannot mutate memory until deterministic admission and compare-and-swap checks succeed.

## Project admission intent

A durable project-local record bound to the elected outcome digest and freezing expected/resulting branch digests, post-state, revision when present, and stable receipt metadata. The complete job/outcome remains in the global decision checkpoint. Once published, recovery rolls the project mutation forward, fails closed on conflicts, then compacts the full intent after its immutable receipt is durable.

## Commit

An admitted, journaled memory mutation against an expected head. Undo creates an inverse commit; it never overwrites unrelated later writes.

## SQLite shadow

A rebuildable observational projection for audit and status. It never fences queue ownership, provider attempts, budgets, proposal decisions, or canonical memory in the current architecture.
