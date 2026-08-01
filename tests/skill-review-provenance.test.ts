import assert from "node:assert/strict";
import test from "node:test";

import type { SkillAuthorshipPacket } from "../src/skill-authorship-packet.ts";
import type { SkillReviewExecutionOutcome } from "../src/skill-review-engine.ts";
import { createSkillReviewJob } from "../src/skill-review-job.ts";
import { createSkillReviewReceipt, parseSkillReviewReceipt } from "../src/skill-review-provenance.ts";

const operation = {
  action: "create" as const,
  name: "release-verification",
  description: "Verify releases with the canonical project checks.",
  content: "# Release verification\n\n1. Run `pnpm check`. Completion criterion: it exits successfully.",
  reason: "This workflow recurs for releases.",
  evidence: ["The user made the check a recurring release step."],
};

function job() {
  const packet: SkillAuthorshipPacket = {
    version: 1,
    kind: "skill-authorship",
    conventions: { memory: [] },
    coverage: {
      frontierEntryId: "user-1",
      includedUserEntryIds: ["user-1"],
      eligibleUserEntryIds: ["user-1"],
      userTurns: 1,
      truncated: false,
      cursorStatus: "from-start",
    },
    evidence: { transcript: "USER: use this release workflow", invokedSkillNames: [], actions: [], redactionCount: 0 },
    corpus: {
      activeTotal: 0, catalog: [], documents: [], catalogOmitted: 0, documentsOmitted: 0,
      pendingTotal: 0, pending: [], pendingOmitted: 0, truncated: false,
    },
  };
  return createSkillReviewJob({ projectKey: "a".repeat(24), sessionId: "private", claimGeneration: 1, packet });
}

function outcome(reviewJob: ReturnType<typeof job>): SkillReviewExecutionOutcome {
  return {
    version: 1,
    kind: "project-skill-review-outcome",
    jobId: reviewJob.id,
    jobDigest: reviewJob.digest,
    disposition: "proposed",
    plan: { operations: [operation] },
    attempts: [{
      ordinal: 1,
      promptDigest: reviewJob.contract.initialPromptDigest,
      requestDigest: reviewJob.contract.requestDigest,
      outputDigest: "b".repeat(64),
      provenance: {
        provider: "test", model: "reviewer", api: "test-api", responseId: "response-1",
        startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.100Z", durationMs: 100,
        usage: {
          input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
        },
      },
    }],
  };
}

test("binds reviewer profile, request, outcome, operation, and actual provenance", () => {
  const reviewJob = job();
  const receipt = createSkillReviewReceipt({
    job: reviewJob,
    outcome: outcome(reviewJob),
    profile: { provider: "test", model: "reviewer", api: "test-api", reasoningEffort: "high", maxOutputTokens: 8192 },
  });

  assert.equal(receipt.jobId, reviewJob.id);
  assert.equal(receipt.requestDigest, reviewJob.contract.requestDigest);
  assert.deepEqual(receipt.target, { kind: "absent", name: "release-verification" });
  assert.equal(receipt.profile.model, "reviewer");
  assert.equal(receipt.attempts[0]?.model, "reviewer");
  assert.equal(receipt.attempts[0]?.costTotal, 0.3);
  assert.deepEqual(parseSkillReviewReceipt(receipt), receipt);
  assert.throws(() => parseSkillReviewReceipt({
    ...receipt,
    profile: { ...receipt.profile, model: "tampered" },
  }), /profile digest mismatch/u);
  assert.throws(() => parseSkillReviewReceipt({
    ...receipt,
    attempts: [{ ...receipt.attempts[0]!, costTotal: 99 }],
  }), /outcome digest|receipt digest/u);
});
