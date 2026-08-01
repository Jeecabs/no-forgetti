import assert from "node:assert/strict";
import test from "node:test";

import type { SkillAuthorshipPacket } from "../src/skill-authorship-packet.ts";
import { createSkillReviewJob, serializeSkillReviewJob, type SkillReviewJob } from "../src/skill-review-job.ts";

function packet(): SkillAuthorshipPacket {
  return {
    version: 1,
    kind: "skill-authorship",
    conventions: { memory: [] },
    coverage: {
      frontierEntryId: "user-1",
      includedUserEntryIds: ["user-1"],
      eligibleUserEntryIds: ["user-1", "later-user"],
      userTurns: 1,
      truncated: true,
      cursorStatus: "resolved",
    },
    evidence: {
      transcript: "USER: preserve this workflow",
      invokedSkillNames: [],
      actions: [],
      redactionCount: 0,
    },
    corpus: {
      activeTotal: 0,
      catalog: [],
      documents: [],
      catalogOmitted: 0,
      documentsOmitted: 0,
      pendingTotal: 0,
      pending: [],
      pendingOmitted: 0,
      truncated: false,
    },
  };
}

test("creates deterministic immutable skill-review jobs with hashed session identity", () => {
  const request = {
    projectKey: "a".repeat(24),
    sessionId: "raw-private-session-id",
    claimGeneration: 7,
    packet: packet(),
  };
  const first = createSkillReviewJob(request);
  const second = createSkillReviewJob(request);
  const serialized = serializeSkillReviewJob(first);

  assert.deepEqual(first, second);
  assert.match(first.id, /^skill_review_[0-9a-f]{40}$/u);
  assert.match(first.digest, /^[0-9a-f]{64}$/u);
  assert.match(first.contract.systemPromptDigest, /^[0-9a-f]{64}$/u);
  assert.match(first.contract.initialPromptDigest, /^[0-9a-f]{64}$/u);
  assert.match(first.contract.requestDigest, /^[0-9a-f]{64}$/u);
  assert.equal(first.coverage.frontierEntryId, "user-1");
  assert.deepEqual(first.coverage.includedUserEntryIds, ["user-1"]);
  assert.equal(Object.hasOwn(first.packet, "coverage"), false);
  assert.doesNotMatch(serialized, /raw-private-session-id|later-user/u);
  assert.throws(() => {
    (first.packet.evidence as { transcript: string }).transcript = "mutated";
  }, /read only|Cannot assign/u);
});

test("job digest changes with captured packet or review generation", () => {
  const base = {
    projectKey: "a".repeat(24),
    sessionId: "session",
    claimGeneration: 1,
    packet: packet(),
  };
  const first = createSkillReviewJob(base);
  const generation = createSkillReviewJob({ ...base, claimGeneration: 2 });
  const changedPacket = packet();
  changedPacket.evidence.transcript = "USER: different evidence";
  const evidence = createSkillReviewJob({ ...base, packet: changedPacket });

  assert.notEqual(first.id, generation.id);
  assert.notEqual(first.digest, generation.digest);
  assert.notEqual(first.id, evidence.id);
});

test("rejects jobs whose pinned prompt contract no longer matches the renderer", () => {
  const original = createSkillReviewJob({
    projectKey: "a".repeat(24),
    sessionId: "session",
    claimGeneration: 1,
    packet: packet(),
  });
  const tampered = JSON.parse(JSON.stringify(original)) as SkillReviewJob;
  tampered.contract.initialPromptDigest = "0".repeat(64);

  assert.throws(() => serializeSkillReviewJob(tampered), /prompt contract mismatch/u);
});
