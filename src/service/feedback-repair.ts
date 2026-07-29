import type { ProposalCommitter } from "./admission.ts";
import type { ReviewDecisionStore } from "./decisions.ts";
import type { ReviewSpool } from "./spool.ts";

export interface FeedbackRepairResult {
  examined: number;
  repaired: number;
  missingEvidence: number;
}

/** Rebuilds missing terminal-failure mailbox events from durable spool authority. */
export async function repairFailedReviewFeedback(request: {
  spool: Pick<ReviewSpool, "failedOutcomes">;
  decisions: Pick<ReviewDecisionStore, "loadReplaySource">;
  committer: Pick<ProposalCommitter, "failed">;
}): Promise<FeedbackRepairResult> {
  if (!request.committer.failed) throw new Error("Terminal feedback repair requires a failure publisher.");
  const outcomes = await request.spool.failedOutcomes();
  const result: FeedbackRepairResult = { examined: outcomes.length, repaired: 0, missingEvidence: 0 };
  for (const outcome of outcomes) {
    const job = await request.decisions.loadReplaySource(outcome.jobId);
    if (!job) {
      result.missingEvidence += 1;
      continue;
    }
    if (job.digest !== outcome.jobDigest) throw new Error("Terminal feedback repair found conflicting job evidence.");
    await request.committer.failed(job, outcome.error);
    result.repaired += 1;
  }
  return result;
}
