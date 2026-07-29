import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectReviewActivityReader } from "../src/service/activity.ts";
import { ReviewFeedbackInbox } from "../src/service/feedback.ts";
import { createReviewJob, createReviewOutcome } from "../src/service/protocol.ts";
import { ReviewSpool } from "../src/service/spool.ts";
import type { ReviewServiceMonitor } from "../src/service/monitor.ts";

const now = new Date("2026-03-01T12:00:00.000Z");

function monitor(overrides: Partial<ReviewServiceMonitor> = {}): ReviewServiceMonitor {
  return {
    mode: "external",
    budget: { day: "2026-03-01", calls: 0, tokens: 0, costUsd: 0 },
    spool: { queued: 0, running: 0, outcomes: 0, deadLetter: 0 },
    workerFresh: true,
    workerCompatible: true,
    exhausted: [],
    observedAt: now.toISOString(),
    ...overrides,
  };
}

function job() {
  return createReviewJob({
    projectKey: "a".repeat(24),
    sessionId: "activity-session",
    throughEntryId: "assistant-1",
    transcript: "USER: Keep project review progress clear.",
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

const provenance = {
  provider: "fake",
  model: "reviewer",
  api: "fake-api",
  startedAt: "2026-03-01T12:00:00.000Z",
  completedAt: "2026-03-01T12:00:01.000Z",
  durationMs: 1_000,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

test("projects project-local review progress from pending interest and authoritative spool state", async () => {
  let clock = now;
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-activity-"));
  const inbox = new ReviewFeedbackInbox(join(root, "project"));
  const spool = new ReviewSpool(join(root, "spool"), { now: () => clock });
  await Promise.all([inbox.initialize(), spool.initialize()]);
  const reviewJob = job();
  await inbox.register({
    jobId: reviewJob.id,
    jobDigest: reviewJob.digest,
    branchName: "main",
    requestedBy: "manual",
    queuedAt: now.toISOString(),
  });
  const reader = new ProjectReviewActivityReader({ inbox, spool, now: () => clock });

  // Feedback interest is not queue authority. A missing spool job can be a
  // retained delivery orphan after its terminal outcome ages out.
  assert.deepEqual(await reader.snapshot(monitor()), {
    observedAt: now.toISOString(),
    jobs: [],
  });

  await spool.enqueue(reviewJob);
  assert.deepEqual((await reader.snapshot(monitor())).jobs.at(0), {
    jobId: reviewJob.id,
    branchName: "main",
    requestedBy: "manual",
    queuedAt: now.toISOString(),
    phase: "queued",
    attempt: 1,
  });
  const claim = await spool.claim({ workerId: "activity-worker", leaseMs: 60_000 });
  assert.ok(claim);
  assert.equal((await reader.snapshot(monitor())).jobs.at(0)?.phase, "reviewing");

  await spool.defer(claim, { delayMs: 5_000 });
  assert.deepEqual((await reader.snapshot(monitor())).jobs.at(0), {
    jobId: reviewJob.id,
    branchName: "main",
    requestedBy: "manual",
    queuedAt: now.toISOString(),
    phase: "retrying",
    attempt: 2,
    retryAt: "2026-03-01T12:00:05.000Z",
  });
  assert.equal((await reader.snapshot(monitor({ workerFresh: false }))).jobs.at(0)?.phase, "paused");
  assert.equal((await reader.snapshot(monitor({ workerFresh: false }))).jobs.at(0)?.pauseReason, "offline");

  clock = new Date("2026-03-01T12:00:05.000Z");
  const retry = await spool.claim({ workerId: "activity-worker", leaseMs: 60_000 });
  assert.ok(retry);
  const outcome = createReviewOutcome(reviewJob, {
    status: "completed",
    completedAt: provenance.completedAt,
    operations: [],
    provenance,
  });
  await spool.finish(retry, outcome);
  assert.equal((await reader.snapshot(monitor())).jobs.at(0)?.phase, "finishing");
});
