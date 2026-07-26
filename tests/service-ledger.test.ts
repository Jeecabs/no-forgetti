import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { LedgerFenceError, SQLiteReviewLedger } from "../src/service/ledger.ts";
import { createReviewJob, createReviewOutcome } from "../src/service/protocol.ts";
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

test("ledger rejects existing version-marked databases with malformed schema", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "no-forgetti-ledger-schema-"));
  const path = join(root, "bad.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE jobs(job_id TEXT); PRAGMA user_version=1;");
  db.close();

  assert.throws(() => new SQLiteReviewLedger(path), /schema/u);
});
