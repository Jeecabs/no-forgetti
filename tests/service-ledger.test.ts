import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { LedgerFenceError, SQLiteReviewLedger } from "../src/service/ledger.ts";
import { createReviewJob, createReviewOutcome, encodeReviewJob } from "../src/service/protocol.ts";
import { ReviewSpool } from "../src/service/spool.ts";
import type { MemoryBranch } from "../src/types.ts";

const branch: MemoryBranch = {
  version: 1,
  name: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  entries: [],
};

function provenance() {
  return {
    provider: "test-provider",
    model: "test-model",
    api: "test-api",
    startedAt: "2026-02-01T00:00:01.000Z",
    completedAt: "2026-02-01T00:00:02.000Z",
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

function job() {
  return createReviewJob({
    projectKey: "c".repeat(24),
    sessionId: "private-session-id",
    throughEntryId: "leaf-7",
    transcript: "USER: remember the release workflow",
    branch,
    maxChars: 4_000,
  });
}

function mode(value: number): number {
  return value & 0o777;
}

test("SQLite WAL ledger shadows jobs, fenced attempts, and outcomes", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "no-forgetti-ledger-"));
  const path = join(root, "state", "review.sqlite");
  const ledger = new SQLiteReviewLedger(path);
  let time = Date.parse("2026-02-01T00:00:00.000Z");
  const spool = new ReviewSpool(join(root, "spool"), { ledger, now: () => new Date(time) });
  const reviewJob = job();

  await spool.enqueue(reviewJob);
  assert.equal(ledger.snapshot(reviewJob.id)?.state, "queued");
  const claim = await spool.claim({ workerId: "reviewer-1", leaseMs: 5_000 });
  assert.ok(claim);
  assert.equal(ledger.snapshot(reviewJob.id)?.state, "running");

  assert.throws(
    () => ledger.recordRenewal({ ...claim, leaseToken: "0".repeat(32), leaseUntil: "2026-02-01T00:00:06.000Z" }),
    LedgerFenceError,
  );
  time += 1_000;
  const renewed = await spool.renew(claim, 5_000);
  const running = ledger.snapshot(reviewJob.id);
  assert.equal(running?.attempts[0]?.leaseUntil, "2026-02-01T00:00:06.000Z");

  const outcome = createReviewOutcome(reviewJob, {
    status: "completed",
    completedAt: "2026-02-01T00:00:02.000Z",
    operations: [{ action: "add", content: "Release through CI.", importance: "high" }],
    provenance: provenance(),
  });
  await spool.finish(renewed, outcome);
  const completed = ledger.snapshot(reviewJob.id);
  assert.equal(completed?.state, "completed");
  assert.equal(completed?.attempts[0]?.state, "completed");
  assert.deepEqual(completed?.outcome, outcome);

  assert.equal(mode((await stat(join(root, "state"))).mode), 0o700);
  assert.equal(mode((await stat(path)).mode), 0o600);
  assert.equal(mode((await stat(`${path}-wal`)).mode), 0o600);
  ledger.close();
});

test("ledger shadows replayable provider-attempt accounting and selected decisions", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "no-forgetti-ledger-provider-attempt-"));
  const ledger = new SQLiteReviewLedger(join(root, "review.sqlite"));
  const reviewJob = job();
  ledger.recordJob(reviewJob);
  const reserved = {
    providerAttemptId: `review_attempt_${"a".repeat(40)}`,
    jobId: reviewJob.id,
    jobDigest: reviewJob.digest,
    claimAttempt: 2,
    leaseToken: "b".repeat(32),
    provider: "test-provider",
    budgetDay: "2026-02-01",
    state: "reserved" as const,
    holdTokens: 400,
    holdCostNanodollars: 500_000_000,
  };

  ledger.recordProviderAttempt(reserved);
  ledger.recordProviderAttempt(structuredClone(reserved));
  ledger.recordProviderAttempt({ ...reserved, state: "dispatched", requestDigest: "c".repeat(64) });
  const settled = {
    ...reserved,
    state: "settled" as const,
    requestDigest: "c".repeat(64),
    usageTokens: 12,
    usageCostNanodollars: 250_000_000,
    provenance: provenance(),
  };
  ledger.recordProviderAttempt(settled);
  ledger.recordProviderAttempt(structuredClone(settled));
  const selectedDecision = {
    jobId: reviewJob.id,
    jobDigest: reviewJob.digest,
    providerAttemptId: reserved.providerAttemptId,
    proposalDigest: "d".repeat(64),
  };
  ledger.recordSelectedDecision(selectedDecision);
  ledger.recordSelectedDecision(structuredClone(selectedDecision));

  assert.deepEqual(ledger.providerAttempt(reserved.providerAttemptId), { ...settled, selected: true });
  assert.deepEqual(ledger.providerAttempts(reviewJob.id), [{ ...settled, selected: true }]);
  assert.deepEqual(ledger.selectedDecision(reviewJob.id), {
    jobId: reviewJob.id,
    jobDigest: reviewJob.digest,
    providerAttemptId: reserved.providerAttemptId,
    proposalDigest: "d".repeat(64),
  });
  assert.throws(
    () => ledger.recordProviderAttempt({ ...settled, usageTokens: 13 }),
    /conflicting review ledger provider attempt/i,
  );
  assert.throws(
    () => ledger.recordProviderAttempt({ ...reserved, state: "canceled" }),
    /conflicting review ledger provider attempt transition/i,
  );
  assert.throws(
    () => ledger.recordSelectedDecision({ ...selectedDecision, proposalDigest: "e".repeat(64) }),
    /conflicting review ledger selected decision/i,
  );
  ledger.close();
});

test("ledger transactionally migrates v1 while preserving job snapshots", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "no-forgetti-ledger-v1-"));
  const path = join(root, "review.sqlite");
  const reviewJob = job();
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY CHECK(length(job_id) = 47), digest TEXT NOT NULL CHECK(length(digest) = 64),
      session_key TEXT NOT NULL CHECK(length(session_key) = 32), envelope TEXT NOT NULL,
      first_seen_at TEXT NOT NULL, state TEXT NOT NULL, active_attempt INTEGER, active_lease_token TEXT
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE attempts (
      job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE, attempt INTEGER NOT NULL,
      lease_token TEXT NOT NULL, worker_id TEXT NOT NULL, claimed_at TEXT NOT NULL, lease_until TEXT NOT NULL,
      state TEXT NOT NULL, finished_at TEXT, PRIMARY KEY(job_id, attempt)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE outcomes (
      job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE, job_digest TEXT NOT NULL,
      lease_token TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT NOT NULL, envelope TEXT NOT NULL
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX attempts_state_lease ON attempts(state, lease_until);
    PRAGMA user_version=1;
  `);
  db.prepare(`
    INSERT INTO jobs(job_id, digest, session_key, envelope, first_seen_at, state, active_attempt, active_lease_token)
    VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL)
  `).run(reviewJob.id, reviewJob.digest, reviewJob.sessionKey, encodeReviewJob(reviewJob), "2026-02-01T00:00:00.000Z");
  db.close();

  const ledger = new SQLiteReviewLedger(path);
  assert.deepEqual(ledger.snapshot(reviewJob.id), { job: reviewJob, state: "queued", attempts: [] });
  ledger.close();
  const migrated = new DatabaseSync(path, { readOnly: true });
  assert.equal((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
  const tables = migrated.prepare(`
    SELECT name, strict, wr FROM pragma_table_list
    WHERE schema = 'main' AND name IN ('provider_attempts', 'selected_decisions') ORDER BY name
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(tables, [
    { name: "provider_attempts", strict: 1, wr: 1 },
    { name: "selected_decisions", strict: 1, wr: 1 },
  ]);
  migrated.close();
});

test("ledger rejects existing version-marked databases with malformed schema", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "no-forgetti-ledger-schema-"));
  const path = join(root, "bad.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE jobs(job_id TEXT); PRAGMA user_version=1;");
  db.close();

  assert.throws(() => new SQLiteReviewLedger(path), /schema/u);
});
