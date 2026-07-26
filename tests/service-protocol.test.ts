import assert from "node:assert/strict";
import test from "node:test";

import {
  createReviewJob,
  createReviewOutcome,
  decodeReviewJob,
  decodeReviewOutcome,
  encodeReviewJob,
  encodeReviewOutcome,
  MAX_REVIEW_JOB_BYTES,
  MAX_REVIEW_TRANSCRIPT_CHARS,
  reviewSessionKey,
} from "../src/service/protocol.ts";
import type { MemoryBranch } from "../src/types.ts";

const branch: MemoryBranch = {
  version: 1,
  name: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  entries: [{
    id: "entry-1",
    text: "Use API_KEY=super-secret-credential-value for deploys.",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    sourceSessionId: "raw-session-must-not-cross-transport",
    createdBy: "assistant_tool",
    importance: "high",
  }],
};

function provenance(completedAt = "2026-01-03T00:00:00.000Z") {
  return {
    provider: "test-provider",
    model: "test-model",
    api: "test-api",
    startedAt: "2026-01-02T23:59:59.000Z",
    completedAt,
    durationMs: 1_000,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    },
  };
}

function job(transcript = "USER: Keep the deploy workflow.\r\nASSISTANT: Noted.") {
  return createReviewJob({
    projectKey: "a".repeat(24),
    sessionId: "private/session/path/123",
    throughEntryId: "message-42",
    transcript,
    branch,
    maxChars: 4_000,
  });
}

test("review envelope has deterministic identity/digest and hashed private identities", () => {
  const first = job();
  const second = job();
  assert.deepEqual(first, second);
  assert.match(first.id, /^review_[0-9a-f]{40}$/u);
  assert.match(first.digest, /^[0-9a-f]{64}$/u);
  assert.equal(first.sessionKey, reviewSessionKey("private/session/path/123"));

  const encoded = encodeReviewJob(first);
  assert.deepEqual(decodeReviewJob(encoded), first);
  assert.doesNotMatch(encoded, /private\/session|raw-session-must-not-cross/u);
  assert.match(encoded, /\[REDACTED\]/u);
  assert.doesNotMatch(encoded, /super-secret-credential/u);
  assert.doesNotMatch(first.transcript, /\r/u);
});

test("job id stays stable while digest detects changed contents for same coverage", () => {
  const first = job("USER: first evidence");
  const changed = job("USER: changed evidence");
  assert.equal(changed.id, first.id);
  assert.notEqual(changed.digest, first.digest);
});

test("review outcomes round-trip through strict bounded schema", () => {
  const reviewJob = job();
  const outcome = createReviewOutcome(reviewJob, {
    status: "completed",
    completedAt: "2026-01-03T00:00:00.000Z",
    operations: [{ action: "add", content: "Deploy through CI.", importance: "normal" }],
    provenance: provenance(),
  });
  assert.deepEqual(decodeReviewOutcome(encodeReviewOutcome(outcome)), outcome);

  const failed = createReviewOutcome(reviewJob, {
    status: "failed",
    completedAt: "2026-01-03T00:00:00.000Z",
    error: { code: "provider_error", message: "API_KEY=another-long-secret-value", retryable: true },
  });
  assert.match(failed.status === "failed" ? failed.error.message : "", /\[REDACTED\]/u);
});

test("rejects malformed, tampered, unknown-field, and oversized envelopes before use", () => {
  const valid = job();
  assert.throws(() => decodeReviewJob("{}"), /envelope|shape/u);
  assert.throws(
    () => decodeReviewJob(JSON.stringify({ ...valid, digest: "0".repeat(64) })),
    /digest does not match/u,
  );
  assert.throws(
    () => decodeReviewJob(JSON.stringify({ ...valid, extra: true })),
    /shape/u,
  );
  assert.throws(
    () => job("x".repeat(MAX_REVIEW_TRANSCRIPT_CHARS + 1)),
    /transcript/u,
  );
  assert.throws(
    () => decodeReviewJob(Buffer.alloc(MAX_REVIEW_JOB_BYTES + 1, 0x20)),
    /exceeds/u,
  );
});
