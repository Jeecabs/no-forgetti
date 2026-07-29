import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ReviewLedger } from "../src/service/ledger.ts";
import {
  createReviewJob,
  createReviewOutcome,
  MAX_REVIEW_JOB_BYTES,
  type ReviewJob,
} from "../src/service/protocol.ts";
import { ReviewLeaseError, ReviewSpool } from "../src/service/spool.ts";
import type { MemoryBranch } from "../src/types.ts";

const branch: MemoryBranch = {
  version: 1,
  name: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  entries: [],
};

function provenance(completedAt: string) {
  return {
    provider: "test-provider",
    model: "test-model",
    api: "test-api",
    startedAt: "2026-02-01T00:00:59.000Z",
    completedAt,
    durationMs: 1_000,
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function reviewJob(transcript = "USER: durable evidence"): ReviewJob {
  return createReviewJob({
    projectKey: "b".repeat(24),
    sessionId: "session-one",
    throughEntryId: "leaf-1",
    transcript,
    branch,
    maxChars: 4_000,
  });
}

async function temporarySpool(options: ConstructorParameters<typeof ReviewSpool>[1] = {}) {
  const parent = await mkdtemp(join(os.tmpdir(), "no-forgetti-spool-"));
  return new ReviewSpool(join(parent, "spool"), options);
}

function permission(mode: number): number {
  return mode & 0o777;
}

test("enqueue is idempotent and quarantines same identity with a different digest", async () => {
  const spool = await temporarySpool();
  const original = reviewJob("USER: original");
  const conflicting = reviewJob("USER: changed");
  assert.equal(original.id, conflicting.id);
  assert.notEqual(original.digest, conflicting.digest);

  assert.equal(await spool.enqueue(original), "enqueued");
  assert.equal(await spool.enqueue(original), "duplicate");
  assert.equal(await spool.enqueue(conflicting), "quarantined");

  const dead = await readdir(spool.deadLetterDir);
  assert.equal(dead.length, 1);
  assert.equal(permission((await stat(spool.root)).mode), 0o700);
  assert.equal(permission((await stat(spool.queuedDir)).mode), 0o700);
  assert.equal(permission((await stat(join(spool.queuedDir, `${original.id}.json`))).mode), 0o600);
  assert.equal(permission((await stat(join(spool.deadLetterDir, dead[0]!))).mode), 0o600);
});

test("expired claim recovery requeues with a new fenced attempt", async () => {
  let time = Date.parse("2026-02-01T00:00:00.000Z");
  const spool = await temporarySpool({ now: () => new Date(time) });
  const job = reviewJob();
  await spool.enqueue(job);

  const first = await spool.claim({ workerId: "worker-1", leaseMs: 100 });
  assert.ok(first);
  assert.equal(first.attempt, 1);
  assert.equal(await spool.claim({ workerId: "worker-2", leaseMs: 100 }), undefined);

  time += 101;
  assert.deepEqual(await spool.recover(), { requeued: 1, quarantined: 0, cleaned: 0 });
  assert.deepEqual(await spool.recover(), { requeued: 0, quarantined: 0, cleaned: 0 });
  const second = await spool.claim({ workerId: "worker-2", leaseMs: 1_000 });
  assert.ok(second);
  assert.equal(second.attempt, 2);
  assert.notEqual(second.leaseToken, first.leaseToken);

  const outcome = createReviewOutcome(job, {
    status: "completed",
    completedAt: "2026-02-01T00:01:00.000Z",
    operations: [],
    provenance: provenance("2026-02-01T00:01:00.000Z"),
  });
  await assert.rejects(() => spool.finish(first, outcome), ReviewLeaseError);
  await assert.rejects(
    () => spool.finish({ ...second, leaseToken: "0".repeat(32) }, outcome),
    ReviewLeaseError,
  );
  assert.equal(await spool.finish(second, outcome), "finished");
  assert.equal(await spool.finish(second, outcome), "duplicate");
  assert.deepEqual(await spool.getOutcome(job.id), outcome);
  assert.equal(permission((await stat(join(spool.outcomesDir, `${job.id}.json`))).mode), 0o600);
});

test("inspect projects one job through queued, running, retry, and terminal states", async () => {
  let time = Date.parse("2026-02-01T00:00:00.000Z");
  const spool = await temporarySpool({ now: () => new Date(time) });
  const job = reviewJob();

  assert.deepEqual(await spool.inspect([job.id]), [{ jobId: job.id, state: "missing" }]);
  await spool.enqueue(job);
  assert.deepEqual(await spool.inspect([job.id]), [{ jobId: job.id, state: "queued", attempt: 1 }]);

  const first = await spool.claim({ workerId: "worker-1", leaseMs: 60_000 });
  assert.ok(first);
  assert.deepEqual(await spool.inspect([job.id]), [{
    jobId: job.id,
    state: "running",
    attempt: 1,
    claimedAt: "2026-02-01T00:00:00.000Z",
  }]);

  await spool.defer(first, { delayMs: 5_000 });
  assert.deepEqual(await spool.inspect([job.id]), [{
    jobId: job.id,
    state: "queued",
    attempt: 2,
    availableAt: "2026-02-01T00:00:05.000Z",
  }]);

  time += 5_000;
  const second = await spool.claim({ workerId: "worker-2", leaseMs: 60_000 });
  assert.ok(second);
  const completedAt = "2026-02-01T00:01:00.000Z";
  const outcome = createReviewOutcome(job, {
    status: "completed",
    completedAt,
    operations: [],
    provenance: provenance(completedAt),
  });
  await spool.finish(second, outcome);
  assert.deepEqual(await spool.inspect([job.id]), [{
    jobId: job.id,
    state: "completed",
    attempt: 2,
    completedAt,
    outcomeStatus: "completed",
  }]);
});

test("defer releases a live claim for an immediate fenced retry", async () => {
  const spool = await temporarySpool();
  const job = reviewJob();
  await spool.enqueue(job);
  const first = await spool.claim({ workerId: "worker-1", leaseMs: 60_000 });
  assert.ok(first);

  assert.equal(await spool.defer(first), "deferred");
  const second = await spool.claim({ workerId: "worker-2", leaseMs: 60_000 });
  assert.ok(second);
  assert.equal(second.attempt, 2);
  assert.notEqual(second.leaseToken, first.leaseToken);
  await assert.rejects(() => spool.defer(first), ReviewLeaseError);
});

test("delayed defer is not claimable until its durable availability time", async () => {
  let time = Date.parse("2026-02-01T00:00:00.000Z");
  const spool = await temporarySpool({ now: () => new Date(time) });
  const job = reviewJob();
  await spool.enqueue(job);
  const first = await spool.claim({ workerId: "worker-1", leaseMs: 60_000 });
  assert.ok(first);

  assert.equal(await spool.defer(first, { delayMs: 30_000 }), "deferred");
  assert.equal(await spool.claim({ workerId: "worker-2", leaseMs: 60_000 }), undefined);

  time += 29_999;
  assert.equal(await spool.claim({ workerId: "worker-2", leaseMs: 60_000 }), undefined);
  time += 1;
  const second = await spool.claim({ workerId: "worker-2", leaseMs: 60_000 });
  assert.ok(second);
  assert.equal(second.attempt, 2);
  assert.notEqual(second.leaseToken, first.leaseToken);
});

test("recovery completes a crashed delayed defer without losing timing or fencing", async () => {
  let time = Date.parse("2026-02-01T00:00:00.000Z");
  const spool = await temporarySpool({ now: () => new Date(time) });
  const job = reviewJob();
  await spool.enqueue(job);
  const first = await spool.claim({ workerId: "worker-1", leaseMs: 60_000 });
  assert.ok(first);
  const runningPath = join(spool.runningDir, `${job.id}.json`);
  const runningRecord = await readFile(runningPath, "utf8");

  await spool.defer(first, { delayMs: 30_000 });
  // Simulate power loss after durable queue publication but before running unlink.
  await writeFile(runningPath, runningRecord, { encoding: "utf8", mode: 0o600 });
  assert.deepEqual(await spool.recover(), { requeued: 0, quarantined: 0, cleaned: 1 });
  assert.equal(await spool.claim({ workerId: "worker-2", leaseMs: 60_000 }), undefined);

  time += 30_000;
  const second = await spool.claim({ workerId: "worker-2", leaseMs: 60_000 });
  assert.ok(second);
  assert.equal(second.attempt, 2);
  assert.notEqual(second.leaseToken, first.leaseToken);
});

test("recovery preserves legacy v1 outcomes with oversized rejected operations", async () => {
  const spool = await temporarySpool();
  await spool.initialize();
  const job = reviewJob();
  const completedAt = "2026-02-01T00:01:00.000Z";
  const legacyOutcome = {
    version: 1 as const,
    jobId: job.id,
    jobDigest: job.digest,
    status: "completed" as const,
    completedAt,
    operations: [{ action: "add" as const, content: "x".repeat(1_403), importance: "normal" as const }],
    provenance: provenance(completedAt),
  };
  await writeFile(join(spool.outcomesDir, `${job.id}.json`), JSON.stringify({
    version: 1,
    attempt: 1,
    workerId: "legacy-worker",
    leaseToken: "1".repeat(32),
    outcome: legacyOutcome,
  }), { encoding: "utf8", mode: 0o600 });

  assert.deepEqual(await spool.recover(), { requeued: 0, quarantined: 0, cleaned: 0 });
  assert.deepEqual(await spool.getOutcome(job.id), legacyOutcome);
  assert.deepEqual(await readdir(spool.deadLetterDir), []);
});

test("recovery dead-letters malformed and oversized spool records", async () => {
  const spool = await temporarySpool();
  await spool.initialize();
  await writeFile(join(spool.queuedDir, "bad.json"), "{not-json", "utf8");
  await writeFile(join(spool.queuedDir, "huge.json"), "x".repeat(MAX_REVIEW_JOB_BYTES + 2_048), "utf8");

  const recovered = await spool.recover();
  assert.equal(recovered.quarantined, 2);
  assert.deepEqual(await readdir(spool.queuedDir), []);
  const dead = await readdir(spool.deadLetterDir);
  assert.equal(dead.length, 2);
  for (const name of dead) assert.equal(permission((await stat(join(spool.deadLetterDir, name))).mode), 0o600);
});

test("terminal retention purge deletes outcomes and quarantined evidence only", async () => {
  const spool = await temporarySpool();
  const job = reviewJob();
  await spool.enqueue(job);
  const claim = await spool.claim({ workerId: "worker", leaseMs: 1_000 });
  assert.ok(claim);
  const outcome = createReviewOutcome(job, {
    status: "completed",
    completedAt: "2026-02-01T00:01:00.000Z",
    operations: [],
    provenance: provenance("2026-02-01T00:01:00.000Z"),
  });
  await spool.finish(claim, outcome);
  await spool.enqueue(reviewJob("USER: changed"));
  assert.equal((await readdir(spool.outcomesDir)).length, 1);
  assert.equal((await readdir(spool.deadLetterDir)).length, 1);

  assert.equal(await spool.purgeTerminalBefore(new Date("2027-01-01T00:00:00.000Z")), 2);
  assert.deepEqual(await readdir(spool.outcomesDir), []);
  assert.deepEqual(await readdir(spool.deadLetterDir), []);
});

test("throwing optional ledger cannot become queue authority", async () => {
  const ledger: ReviewLedger = {
    recordJob() { throw new Error("shadow unavailable"); },
    recordClaim() { throw new Error("shadow unavailable"); },
    recordRenewal() { throw new Error("shadow unavailable"); },
    recordRecovery() { throw new Error("shadow unavailable"); },
    recordOutcome() { throw new Error("shadow unavailable"); },
  };
  const errors: unknown[] = [];
  const spool = await temporarySpool({ ledger, onLedgerError: (error) => errors.push(error) });
  const job = reviewJob();
  assert.equal(await spool.enqueue(job), "enqueued");
  assert.ok(await spool.claim({ workerId: "worker", leaseMs: 1_000 }));
  assert.equal(errors.length, 2);
});
