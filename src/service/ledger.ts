import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  decodeReviewJob,
  decodeReviewOutcome,
  encodeReviewJob,
  encodeReviewOutcome,
  MAX_REVIEW_JOB_BYTES,
  MAX_REVIEW_OUTCOME_BYTES,
  type ReviewJob,
  type ReviewOutcome,
} from "./protocol.ts";

const LEDGER_VERSION = 1;
const MAX_LEDGER_BYTES = 256 * 1024 * 1024;
const LEASE_TOKEN = /^[0-9a-f]{32}$/u;
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface LedgerAttempt {
  job: ReviewJob;
  attempt: number;
  workerId: string;
  leaseToken: string;
  claimedAt: string;
  leaseUntil: string;
}

export interface LedgerAttemptSnapshot {
  attempt: number;
  workerId: string;
  leaseToken: string;
  claimedAt: string;
  leaseUntil: string;
  state: "running" | "recovered" | "completed" | "failed";
  finishedAt?: string;
}

export interface ReviewLedgerSnapshot {
  job: ReviewJob;
  state: "queued" | "running" | "completed" | "failed";
  attempts: LedgerAttemptSnapshot[];
  outcome?: ReviewOutcome;
}

/** Optional observational shadow. Spool state, never this interface, fences work. */
export interface ReviewLedger {
  recordJob(job: ReviewJob, observedAt?: string): void;
  recordClaim(attempt: LedgerAttempt): void;
  recordRenewal(attempt: LedgerAttempt): void;
  recordRecovery(attempt: LedgerAttempt, recoveredAt: string): void;
  recordOutcome(attempt: LedgerAttempt, outcome: ReviewOutcome): void;
}

export class LedgerFenceError extends Error {
  constructor(message = "Stale review ledger lease token.") {
    super(message);
    this.name = "LedgerFenceError";
  }
}

interface DbJobRow {
  digest: string;
  envelope: string;
  state: ReviewLedgerSnapshot["state"];
  active_attempt: number | null;
  active_lease_token: string | null;
}

interface DbAttemptRow {
  attempt: number;
  worker_id: string;
  lease_token: string;
  claimed_at: string;
  lease_until: string;
  state: LedgerAttemptSnapshot["state"];
  finished_at: string | null;
}

interface DbOutcomeRow {
  lease_token: string;
  envelope: string;
}

function checkedIso(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`Invalid ${label}.`);
  return value;
}

function validateAttempt(value: LedgerAttempt): LedgerAttempt {
  const job = decodeReviewJob(encodeReviewJob(value.job));
  if (!Number.isSafeInteger(value.attempt) || value.attempt < 1) throw new Error("Invalid review attempt number.");
  if (!WORKER_ID.test(value.workerId)) throw new Error("Invalid review worker id.");
  if (!LEASE_TOKEN.test(value.leaseToken)) throw new Error("Invalid review lease token.");
  const claimedAt = checkedIso(value.claimedAt, "review claim timestamp");
  const leaseUntil = checkedIso(value.leaseUntil, "review lease timestamp");
  if (leaseUntil <= claimedAt) throw new Error("Review lease must end after its claim.");
  return { job, attempt: value.attempt, workerId: value.workerId, leaseToken: value.leaseToken, claimedAt, leaseUntil };
}

interface SchemaColumn {
  name: string;
  type: "TEXT" | "INTEGER";
  notnull: 0 | 1;
  pk: number;
}

function exactSchema(db: DatabaseSync, table: string, columns: readonly SchemaColumn[]): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: unknown;
    type: unknown;
    notnull: unknown;
    dflt_value: unknown;
    pk: unknown;
  }>;
  const tableRow = db.prepare("SELECT wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = ?")
    .get(table) as unknown as { wr?: unknown; strict?: unknown } | undefined;
  if (tableRow?.wr !== 1 || tableRow.strict !== 1 || rows.length !== columns.length || rows.some((row, index) => {
    const expected = columns[index];
    return !expected || row.name !== expected.name || row.type !== expected.type
      || row.notnull !== expected.notnull || row.pk !== expected.pk || row.dflt_value !== null;
  })) throw new Error(`Invalid review ledger ${table} schema.`);
}

export class SQLiteReviewLedger implements ReviewLedger {
  readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    if (!path || path === ":memory:") throw new Error("Review ledger requires a filesystem path.");
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.path), 0o700);
    try {
      const info = lstatSync(this.path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Review ledger path must be a regular file.");
      if (info.size > MAX_LEDGER_BYTES) throw new Error(`Review ledger exceeds ${MAX_LEDGER_BYTES} bytes.`);
      chmodSync(this.path, 0o600);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    }

    this.db = new DatabaseSync(this.path, { allowExtension: false, timeout: 5_000 });
    try {
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA journal_size_limit=8388608;");
      const page = this.db.prepare("PRAGMA page_size").get() as unknown as { page_size?: unknown };
      const pageSize = Number(page.page_size);
      if (!Number.isSafeInteger(pageSize) || pageSize < 512) throw new Error("Invalid review ledger page size.");
      this.db.exec(`PRAGMA max_page_count=${Math.max(1, Math.floor(MAX_LEDGER_BYTES / pageSize))}`);
      const journal = this.db.prepare("PRAGMA journal_mode=WAL").get() as unknown as { journal_mode?: unknown };
      if (journal.journal_mode !== "wal") throw new Error("Review ledger could not enable WAL mode.");
      const version = this.db.prepare("PRAGMA user_version").get() as unknown as { user_version?: unknown };
      if (version.user_version === 0) this.createSchema();
      else if (version.user_version !== LEDGER_VERSION) throw new Error(`Unsupported review ledger version: ${String(version.user_version)}.`);
      this.validateSchema();
      this.db.enableDefensive?.(true);
      this.secureFiles();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  recordJob(job: ReviewJob, observedAt = new Date().toISOString()): void {
    this.assertOpen();
    const envelope = encodeReviewJob(job);
    const parsed = decodeReviewJob(envelope);
    const seenAt = checkedIso(observedAt, "review ledger observation timestamp");
    this.db.prepare(`
      INSERT INTO jobs(job_id, digest, session_key, envelope, first_seen_at, state, active_attempt, active_lease_token)
      VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL)
      ON CONFLICT(job_id) DO NOTHING
    `).run(parsed.id, parsed.digest, parsed.sessionKey, envelope, seenAt);
    const row = this.jobRow(parsed.id);
    if (!row || row.digest !== parsed.digest || row.envelope !== envelope) {
      throw new Error(`Conflicting review ledger job: ${parsed.id}.`);
    }
    this.secureFiles();
  }

  recordClaim(value: LedgerAttempt): void {
    this.assertOpen();
    const claim = validateAttempt(value);
    this.recordJob(claim.job, claim.claimedAt);
    this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT attempt, worker_id, lease_token, claimed_at, lease_until, state, finished_at
        FROM attempts WHERE job_id = ? AND attempt = ?
      `).get(claim.job.id, claim.attempt) as unknown as DbAttemptRow | undefined;
      if (existing && (
        existing.lease_token !== claim.leaseToken
        || existing.worker_id !== claim.workerId
        || existing.claimed_at !== claim.claimedAt
      )) throw new LedgerFenceError("Conflicting review ledger attempt fencing token.");
      if (existing && (existing.state === "completed" || existing.state === "failed")) return;
      if (existing?.state === "recovered") throw new LedgerFenceError("Recovered review ledger attempt cannot be reclaimed.");
      if (!existing) {
        this.db.prepare(`
          INSERT INTO attempts(job_id, attempt, lease_token, worker_id, claimed_at, lease_until, state, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, 'running', NULL)
        `).run(claim.job.id, claim.attempt, claim.leaseToken, claim.workerId, claim.claimedAt, claim.leaseUntil);
      } else {
        this.db.prepare("UPDATE attempts SET lease_until = ? WHERE job_id = ? AND attempt = ? AND lease_token = ?")
          .run(claim.leaseUntil, claim.job.id, claim.attempt, claim.leaseToken);
      }
      this.db.prepare(`
        UPDATE jobs SET state = 'running', active_attempt = ?, active_lease_token = ?
        WHERE job_id = ? AND digest = ?
      `).run(claim.attempt, claim.leaseToken, claim.job.id, claim.job.digest);
    });
    this.secureFiles();
  }

  recordRenewal(value: LedgerAttempt): void {
    this.assertOpen();
    const claim = validateAttempt(value);
    this.transaction(() => {
      const attempt = this.db.prepare(`
        UPDATE attempts SET lease_until = ?
        WHERE job_id = ? AND attempt = ? AND lease_token = ? AND state = 'running'
      `).run(claim.leaseUntil, claim.job.id, claim.attempt, claim.leaseToken);
      const job = this.db.prepare(`
        UPDATE jobs SET active_attempt = ?, active_lease_token = ?
        WHERE job_id = ? AND digest = ? AND state = 'running'
          AND active_attempt = ? AND active_lease_token = ?
      `).run(claim.attempt, claim.leaseToken, claim.job.id, claim.job.digest, claim.attempt, claim.leaseToken);
      if (attempt.changes !== 1 || job.changes !== 1) throw new LedgerFenceError();
    });
    this.secureFiles();
  }

  recordRecovery(value: LedgerAttempt, recoveredAt: string): void {
    this.assertOpen();
    const claim = validateAttempt(value);
    const timestamp = checkedIso(recoveredAt, "review recovery timestamp");
    this.transaction(() => {
      const row = this.db.prepare(`
        SELECT lease_token, state FROM attempts WHERE job_id = ? AND attempt = ?
      `).get(claim.job.id, claim.attempt) as unknown as { lease_token?: unknown; state?: unknown } | undefined;
      if (!row || row.lease_token !== claim.leaseToken) throw new LedgerFenceError();
      if (row.state === "running") {
        this.db.prepare(`
          UPDATE attempts SET state = 'recovered', finished_at = ?
          WHERE job_id = ? AND attempt = ? AND lease_token = ? AND state = 'running'
        `).run(timestamp, claim.job.id, claim.attempt, claim.leaseToken);
      } else if (row.state !== "recovered") {
        throw new LedgerFenceError("Cannot recover a finished review ledger attempt.");
      }
      this.db.prepare(`
        UPDATE jobs SET state = 'queued', active_attempt = NULL, active_lease_token = NULL
        WHERE job_id = ? AND digest = ? AND active_attempt = ? AND active_lease_token = ?
      `).run(claim.job.id, claim.job.digest, claim.attempt, claim.leaseToken);
    });
    this.secureFiles();
  }

  recordOutcome(value: LedgerAttempt, outcome: ReviewOutcome): void {
    this.assertOpen();
    const claim = validateAttempt(value);
    const encoded = encodeReviewOutcome(outcome);
    const parsed = decodeReviewOutcome(encoded);
    if (parsed.jobId !== claim.job.id || parsed.jobDigest !== claim.job.digest) throw new Error("Review outcome does not match ledger attempt.");
    this.transaction(() => {
      const prior = this.db.prepare("SELECT lease_token, envelope FROM outcomes WHERE job_id = ?")
        .get(claim.job.id) as unknown as DbOutcomeRow | undefined;
      if (prior) {
        if (prior.lease_token !== claim.leaseToken) throw new LedgerFenceError();
        if (prior.envelope !== encoded) throw new Error("Conflicting review ledger outcome.");
        return;
      }
      const job = this.jobRow(claim.job.id);
      if (!job || job.digest !== claim.job.digest || job.state !== "running"
        || job.active_attempt !== claim.attempt || job.active_lease_token !== claim.leaseToken) {
        throw new LedgerFenceError();
      }
      const state = parsed.status === "completed" ? "completed" : "failed";
      const attempt = this.db.prepare(`
        UPDATE attempts SET state = ?, finished_at = ?
        WHERE job_id = ? AND attempt = ? AND lease_token = ? AND state = 'running'
      `).run(state, parsed.completedAt, claim.job.id, claim.attempt, claim.leaseToken);
      if (attempt.changes !== 1) throw new LedgerFenceError();
      this.db.prepare(`
        INSERT INTO outcomes(job_id, job_digest, lease_token, status, completed_at, envelope)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(claim.job.id, claim.job.digest, claim.leaseToken, parsed.status, parsed.completedAt, encoded);
      this.db.prepare(`
        UPDATE jobs SET state = ?, active_attempt = NULL, active_lease_token = NULL
        WHERE job_id = ? AND digest = ? AND active_attempt = ? AND active_lease_token = ?
      `).run(state, claim.job.id, claim.job.digest, claim.attempt, claim.leaseToken);
    });
    this.secureFiles();
  }

  purgeTerminalBefore(cutoff: Date): number {
    this.assertOpen();
    if (!Number.isFinite(cutoff.getTime())) throw new Error("Invalid review ledger retention cutoff.");
    const result = this.db.prepare(`
      DELETE FROM jobs
      WHERE job_id IN (SELECT job_id FROM outcomes WHERE completed_at < ?)
    `).run(cutoff.toISOString());
    this.secureFiles();
    return Number(result.changes);
  }

  snapshot(jobId: string): ReviewLedgerSnapshot | undefined {
    this.assertOpen();
    if (!/^review_[0-9a-f]{40}$/u.test(jobId)) throw new Error("Invalid review ledger job id.");
    const row = this.jobRow(jobId);
    if (!row) return undefined;
    const job = decodeReviewJob(row.envelope);
    if (job.id !== jobId || job.digest !== row.digest) throw new Error("Corrupt review ledger job row.");
    const attempts = (this.db.prepare(`
      SELECT attempt, worker_id, lease_token, claimed_at, lease_until, state, finished_at
      FROM attempts WHERE job_id = ? ORDER BY attempt
    `).all(jobId) as unknown as DbAttemptRow[]).map((attempt): LedgerAttemptSnapshot => ({
      attempt: Number(attempt.attempt),
      workerId: String(attempt.worker_id),
      leaseToken: String(attempt.lease_token),
      claimedAt: checkedIso(String(attempt.claimed_at), "stored review claim timestamp"),
      leaseUntil: checkedIso(String(attempt.lease_until), "stored review lease timestamp"),
      state: attempt.state,
      ...(attempt.finished_at ? { finishedAt: checkedIso(String(attempt.finished_at), "stored review finish timestamp") } : {}),
    }));
    const outcomeRow = this.db.prepare("SELECT lease_token, envelope FROM outcomes WHERE job_id = ?")
      .get(jobId) as unknown as DbOutcomeRow | undefined;
    const outcome = outcomeRow ? decodeReviewOutcome(outcomeRow.envelope) : undefined;
    return { job, state: row.state, attempts, ...(outcome ? { outcome } : {}) };
  }

  close(): void {
    if (this.closed) return;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
    this.closed = true;
    this.secureFiles();
  }

  private createSchema(): void {
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE jobs (
        job_id TEXT PRIMARY KEY CHECK(length(job_id) = 47),
        digest TEXT NOT NULL CHECK(length(digest) = 64),
        session_key TEXT NOT NULL CHECK(length(session_key) = 32),
        envelope TEXT NOT NULL CHECK(json_valid(envelope) AND length(CAST(envelope AS BLOB)) <= ${MAX_REVIEW_JOB_BYTES}),
        first_seen_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'completed', 'failed')),
        active_attempt INTEGER,
        active_lease_token TEXT,
        CHECK((state = 'running') = (active_attempt IS NOT NULL AND active_lease_token IS NOT NULL))
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE attempts (
        job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL CHECK(attempt > 0),
        lease_token TEXT NOT NULL CHECK(length(lease_token) = 32),
        worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 128),
        claimed_at TEXT NOT NULL,
        lease_until TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('running', 'recovered', 'completed', 'failed')),
        finished_at TEXT,
        PRIMARY KEY(job_id, attempt)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE outcomes (
        job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
        job_digest TEXT NOT NULL CHECK(length(job_digest) = 64),
        lease_token TEXT NOT NULL CHECK(length(lease_token) = 32),
        status TEXT NOT NULL CHECK(status IN ('completed', 'failed')),
        completed_at TEXT NOT NULL,
        envelope TEXT NOT NULL CHECK(json_valid(envelope) AND length(CAST(envelope AS BLOB)) <= ${MAX_REVIEW_OUTCOME_BYTES})
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX attempts_state_lease ON attempts(state, lease_until);
      PRAGMA user_version=${LEDGER_VERSION};
      COMMIT;
    `);
  }

  private validateSchema(): void {
    exactSchema(this.db, "jobs", [
      { name: "job_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "digest", type: "TEXT", notnull: 1, pk: 0 },
      { name: "session_key", type: "TEXT", notnull: 1, pk: 0 },
      { name: "envelope", type: "TEXT", notnull: 1, pk: 0 },
      { name: "first_seen_at", type: "TEXT", notnull: 1, pk: 0 },
      { name: "state", type: "TEXT", notnull: 1, pk: 0 },
      { name: "active_attempt", type: "INTEGER", notnull: 0, pk: 0 },
      { name: "active_lease_token", type: "TEXT", notnull: 0, pk: 0 },
    ]);
    exactSchema(this.db, "attempts", [
      { name: "job_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "attempt", type: "INTEGER", notnull: 1, pk: 2 },
      { name: "lease_token", type: "TEXT", notnull: 1, pk: 0 },
      { name: "worker_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "claimed_at", type: "TEXT", notnull: 1, pk: 0 },
      { name: "lease_until", type: "TEXT", notnull: 1, pk: 0 },
      { name: "state", type: "TEXT", notnull: 1, pk: 0 },
      { name: "finished_at", type: "TEXT", notnull: 0, pk: 0 },
    ]);
    exactSchema(this.db, "outcomes", [
      { name: "job_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "job_digest", type: "TEXT", notnull: 1, pk: 0 },
      { name: "lease_token", type: "TEXT", notnull: 1, pk: 0 },
      { name: "status", type: "TEXT", notnull: 1, pk: 0 },
      { name: "completed_at", type: "TEXT", notnull: 1, pk: 0 },
      { name: "envelope", type: "TEXT", notnull: 1, pk: 0 },
    ]);
  }

  private jobRow(jobId: string): DbJobRow | undefined {
    return this.db.prepare(`
      SELECT digest, envelope, state, active_attempt, active_lease_token FROM jobs WHERE job_id = ?
    `).get(jobId) as unknown as DbJobRow | undefined;
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve original transaction failure.
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Review ledger is closed.");
  }

  private secureFiles(): void {
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try {
        chmodSync(path, 0o600);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
      }
    }
  }
}
