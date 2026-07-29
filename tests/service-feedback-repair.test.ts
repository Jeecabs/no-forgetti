import assert from "node:assert/strict";
import test from "node:test";

import { repairFailedReviewFeedback } from "../src/service/feedback-repair.ts";
import { createReviewJob, createReviewOutcome } from "../src/service/protocol.ts";

function job(throughEntryId: string) {
  return createReviewJob({
    projectKey: "a".repeat(24),
    sessionId: "repair-session",
    throughEntryId,
    transcript: `USER: ${throughEntryId}`,
    branch: {
      version: 1,
      name: "main",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      entries: [],
    },
    maxChars: 6_000,
  });
}

test("terminal feedback repair republishes failed outcomes from retained job evidence", async () => {
  const retained = job("retained");
  const expired = job("expired");
  const failure = { code: "provider_error", message: "Provider failed.", retryable: false };
  const retainedOutcome = createReviewOutcome(retained, { status: "failed", error: failure });
  const expiredOutcome = createReviewOutcome(expired, { status: "failed", error: failure });
  assert.equal(retainedOutcome.status, "failed");
  assert.equal(expiredOutcome.status, "failed");
  if (retainedOutcome.status !== "failed" || expiredOutcome.status !== "failed") return;
  const published: string[] = [];

  const result = await repairFailedReviewFeedback({
    spool: { async failedOutcomes() { return [retainedOutcome, expiredOutcome]; } },
    decisions: { async loadReplaySource(jobId) { return jobId === retained.id ? retained : undefined; } },
    committer: { async failed(source) { published.push(source.id); } },
  });

  assert.deepEqual(result, { examined: 2, repaired: 1, missingEvidence: 1 });
  assert.deepEqual(published, [retained.id]);
});
