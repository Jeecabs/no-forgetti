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

A durable, deterministic request to refine memory from bounded sanitized evidence. Accepted jobs are eventually processed subject to explicit budgets and available reviewer credentials.

## Proposal

Evidence-linked typed operations returned by a reviewer. A proposal cannot mutate memory until deterministic admission and compare-and-swap checks succeed.

## Commit

An admitted, journaled memory mutation against an expected head. Undo creates an inverse commit; it never overwrites unrelated later writes.
