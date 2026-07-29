import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_REVIEW_PROPOSAL_DECISION_BYTES,
  ReviewDecisionStore,
} from "../src/service/decisions.ts";
import { createReviewJob, type ReviewModelProvenance } from "../src/service/protocol.ts";
import type { MemoryBranch, ReviewOperation } from "../src/types.ts";

const provenance: ReviewModelProvenance = {
  provider: "fake-provider",
  model: "reviewer",
  api: "fake-api",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  durationMs: 1_000,
  usage: {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 0,
    totalTokens: 17,
    cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
  },
};

const branch: MemoryBranch = {
  version: 1,
  name: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  entries: [],
};

function reviewJob(transcript = "USER: remember pnpm check", throughEntryId = "entry-1") {
  return createReviewJob({
    projectKey: "a".repeat(16),
    sessionId: "private-session",
    throughEntryId,
    transcript,
    branch,
    maxChars: 16_000,
  });
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-decisions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new ReviewDecisionStore(root), job: reviewJob() };
}

test("completed provider result is checkpointed and selected for recovery", async (t) => {
  const { root, store, job } = await fixture(t);
  const result = await store.recordAttempt("attempt-1", job, {
    status: "completed",
    completedAt: provenance.completedAt,
    operations: [{ action: "add", content: "Run pnpm check.", importance: "high" }],
    provenance,
  });

  assert.equal(result.disposition, "selected");
  assert.equal(result.attempt.proposalDigest, result.decision?.proposalDigest);
  assert.deepEqual(await store.loadDecision(job.id), result.decision);
  assert.deepEqual(result.decision?.job, job);
  assert.equal(result.decision?.outcome.status, "completed");
  assert.equal((await stat(join(root, "provider-results", job.id, "attempt-1.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "proposal-decisions", `${job.id}.json`))).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "provider-results", job.id))).mode & 0o777, 0o700);
});

test("identical attempt replay is a no-op but conflicting replay fails closed", async (t) => {
  const { store, job } = await fixture(t);
  const firstResult = {
    status: "completed" as const,
    completedAt: provenance.completedAt,
    operations: [{ action: "add" as const, content: "Run pnpm check.", importance: "high" as const }],
    provenance,
  };
  const first = await store.recordAttempt("attempt-1", job, firstResult);
  const replay = await store.recordAttempt("attempt-1", job, structuredClone(firstResult));

  assert.equal(replay.disposition, "replayed");
  assert.deepEqual(replay.attempt, first.attempt);
  assert.deepEqual(replay.decision, first.decision);
  await assert.rejects(
    store.recordAttempt("attempt-1", job, { ...firstResult, operations: [] }),
    /conflicting provider result.*attempt-1/i,
  );
  assert.deepEqual(await store.loadAttempt(job.id, "attempt-1"), first.attempt);
});

test("failed attempts are sanitized and accounted without winning", async (t) => {
  const { store, job } = await fixture(t);
  const failed = await store.recordAttempt("attempt-failed", job, {
    status: "failed",
    completedAt: "2026-01-01T00:00:02.000Z",
    error: { code: "provider_error", message: "API_KEY=super-secret-token-value", retryable: true },
    provenance,
  });

  assert.equal(failed.disposition, "accounted");
  assert.equal(failed.attempt.proposalDigest, null);
  assert.equal(failed.decision, undefined);
  assert.equal(failed.attempt.outcome.status, "failed");
  if (failed.attempt.outcome.status === "failed") {
    assert.equal(failed.attempt.outcome.error.message, "API_KEY=[REDACTED]");
    assert.deepEqual(failed.attempt.outcome.provenance?.usage, provenance.usage);
  }
  assert.equal(await store.loadDecision(job.id), undefined);
  assert.deepEqual(await store.loadReplaySource(job.id), job);
});

test("concurrent completed attempts are both accounted but exactly one wins", async (t) => {
  const { store, job } = await fixture(t);
  const secondProvenance: ReviewModelProvenance = {
    ...provenance,
    startedAt: "2026-01-01T00:00:02.000Z",
    completedAt: "2026-01-01T00:00:03.000Z",
    durationMs: 1_000,
  };
  const [one, two] = await Promise.all([
    store.recordAttempt("attempt-1", job, {
      status: "completed",
      completedAt: provenance.completedAt,
      operations: [{ action: "add", content: "Remember first.", importance: "normal" }],
      provenance,
    }),
    store.recordAttempt("attempt-2", job, {
      status: "completed",
      completedAt: secondProvenance.completedAt,
      operations: [{ action: "add", content: "Remember second.", importance: "normal" }],
      provenance: secondProvenance,
    }),
  ]);

  assert.deepEqual([one.disposition, two.disposition].sort(), ["accounted", "selected"]);
  const decision = await store.loadDecision(job.id);
  assert.ok(decision);
  assert.ok(decision.attemptId === "attempt-1" || decision.attemptId === "attempt-2");
  assert.equal(one.decision?.attemptId, decision.attemptId);
  assert.equal(two.decision?.attemptId, decision.attemptId);
  assert.ok(await store.loadAttempt(job.id, "attempt-1"));
  assert.ok(await store.loadAttempt(job.id, "attempt-2"));
});

test("retention purges terminal decisions and attempts but preserves protected jobs", async (t) => {
  const { root, store, job: terminalJob } = await fixture(t);
  const protectedJob = reviewJob("USER: keep this nonterminal job", "entry-2");
  const completed = {
    status: "completed" as const,
    completedAt: provenance.completedAt,
    operations: [] as ReviewOperation[],
    provenance,
  };
  await store.recordAttempt("attempt-terminal", terminalJob, completed);
  await store.recordAttempt("attempt-protected", protectedJob, completed);

  const cutoff = new Date("2027-01-01T00:00:00.000Z");
  assert.equal(await store.purgeTerminalBefore(cutoff, new Set([protectedJob.id])), 2);
  assert.equal(await store.loadAttempt(terminalJob.id, "attempt-terminal"), undefined);
  assert.equal(await store.loadDecision(terminalJob.id), undefined);
  assert.ok(await store.loadAttempt(protectedJob.id, "attempt-protected"));
  assert.ok(await store.loadDecision(protectedJob.id));

  assert.equal(await store.purgeTerminalBefore(cutoff, []), 2);
  assert.equal(await store.loadAttempt(protectedJob.id, "attempt-protected"), undefined);
  assert.equal(await store.loadDecision(protectedJob.id), undefined);
  assert.equal((await stat(join(root, "provider-results"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, "proposal-decisions"))).mode & 0o777, 0o700);
});

test("retention keeps protected failed attempts and cleans old private temporaries", async (t) => {
  const { root, store, job } = await fixture(t);
  await store.recordAttempt("attempt-failed", job, {
    status: "failed",
    completedAt: "2026-01-01T00:00:02.000Z",
    error: { code: "provider_error", message: "temporary failure", retryable: true },
  });
  const uuid = "12345678-1234-1234-1234-123456789abc";
  const attemptTemporary = join(root, "provider-results", job.id, `.${uuid}.tmp`);
  const decisionTemporary = join(root, "proposal-decisions", `.${uuid}.tmp`);
  await writeFile(attemptTemporary, "private", { mode: 0o600 });
  await writeFile(decisionTemporary, "private", { mode: 0o600 });

  const cutoff = new Date("2027-01-01T00:00:00.000Z");
  assert.equal(await store.purgeTerminalBefore(cutoff, [job.id]), 1);
  assert.ok(await store.loadAttempt(job.id, "attempt-failed"));
  assert.deepEqual(await readdir(join(root, "provider-results", job.id)), [
    `.${uuid}.tmp`,
    "attempt-failed.json",
  ]);

  assert.equal(await store.purgeTerminalBefore(cutoff, []), 2);
  assert.equal(await store.loadAttempt(job.id, "attempt-failed"), undefined);
  await assert.rejects(stat(attemptTemporary), { code: "ENOENT" });
});

test("malformed and oversized authority files fail closed", async (t) => {
  const { root, store, job } = await fixture(t);
  await store.recordAttempt("attempt-1", job, {
    status: "completed",
    completedAt: provenance.completedAt,
    operations: [],
    provenance,
  });
  const decisionPath = join(root, "proposal-decisions", `${job.id}.json`);
  await writeFile(decisionPath, `${JSON.stringify({ version: 1, unexpected: true })}\n`, { mode: 0o600 });
  await assert.rejects(store.loadDecision(job.id), /object shape/i);
  await assert.rejects(
    store.purgeTerminalBefore(new Date("2027-01-01T00:00:00.000Z"), []),
    /object shape/i,
  );
  assert.ok(await store.loadAttempt(job.id, "attempt-1"));
  assert.ok(await stat(decisionPath));

  await writeFile(decisionPath, "x".repeat(MAX_REVIEW_PROPOSAL_DECISION_BYTES + 1), { mode: 0o600 });
  await assert.rejects(store.loadDecision(job.id), /exceeds.*bytes/i);
});
