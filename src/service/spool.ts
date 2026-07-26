import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { atomicWriteFile } from "../atomic-file.ts";
import { withFileLock } from "../file-lock.ts";
import type { LedgerAttempt, ReviewLedger } from "./ledger.ts";
import {
  decodeReviewJob,
  decodeReviewOutcome,
  encodeReviewJob,
  encodeReviewOutcome,
  MAX_REVIEW_JOB_BYTES,
  MAX_REVIEW_OUTCOME_BYTES,
  parseReviewJob,
  parseReviewOutcome,
  type ReviewJob,
  type ReviewOutcome,
} from "./protocol.ts";

const SPOOL_RECORD_VERSION = 1;
const MAX_QUEUE_RECORD_BYTES = MAX_REVIEW_JOB_BYTES + 1_024;
const MAX_RUNNING_RECORD_BYTES = MAX_REVIEW_JOB_BYTES + 4_096;
const MAX_OUTCOME_RECORD_BYTES = MAX_REVIEW_OUTCOME_BYTES + 1_024;
const MAX_DEAD_LETTER_BYTES = MAX_REVIEW_JOB_BYTES + 2_048;
const MAX_DIRECTORY_FILES = 10_000;
const MIN_LEASE_MS = 1;
const MAX_LEASE_MS = 24 * 60 * 60 * 1_000;
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LEASE_TOKEN = /^[0-9a-f]{32}$/u;

interface QueueRecord {
  version: 1;
  job: ReviewJob;
  nextAttempt: number;
  availableAt?: string;
}

interface RunningRecord extends LedgerAttempt {
  version: 1;
}

interface OutcomeRecord {
  version: 1;
  attempt: number;
  workerId: string;
  leaseToken: string;
  outcome: ReviewOutcome;
}

export interface ReviewClaim extends LedgerAttempt {}

export interface ClaimOptions {
  workerId: string;
  leaseMs: number;
}

export interface DeferOptions {
  /** Keep the next fenced attempt unavailable for this durable delay. */
  delayMs?: number;
}

export type EnqueueResult = "enqueued" | "duplicate" | "quarantined";
export type FinishResult = "finished" | "duplicate";
export type DeferResult = "deferred";

export interface RecoveryResult {
  requeued: number;
  quarantined: number;
  cleaned: number;
}

export interface ReviewSpoolOptions {
  ledger?: ReviewLedger;
  now?: () => Date;
  onLedgerError?: (error: unknown) => void;
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export class ReviewLeaseError extends Error {
  constructor(message = "Stale or expired review lease token.") {
    super(message);
    this.name = "ReviewLeaseError";
  }
}

export class ReviewSpoolConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSpoolConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) || actual.some((key) => !keys.includes(key))) {
    throw new Error("Invalid review spool record shape.");
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`Invalid ${label}.`);
  return value as number;
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`Invalid ${label}.`);
  return value;
}

function workerId(value: unknown): string {
  if (typeof value !== "string" || !WORKER_ID.test(value)) throw new Error("Invalid review worker id.");
  return value;
}

function leaseToken(value: unknown): string {
  if (typeof value !== "string" || !LEASE_TOKEN.test(value)) throw new Error("Invalid review lease token.");
  return value;
}

function parseQueueRecord(value: unknown): QueueRecord {
  if (!isRecord(value)) throw new Error("Invalid queued review record.");
  const hasAvailableAt = Object.hasOwn(value, "availableAt");
  exactKeys(value, hasAvailableAt
    ? ["version", "job", "nextAttempt", "availableAt"]
    : ["version", "job", "nextAttempt"]);
  if (value.version !== SPOOL_RECORD_VERSION) throw new Error("Unsupported queued review record version.");
  return {
    version: 1,
    job: parseReviewJob(value.job),
    nextAttempt: positiveInteger(value.nextAttempt, "queued review attempt"),
    ...(hasAvailableAt ? { availableAt: isoTimestamp(value.availableAt, "queued review availability timestamp") } : {}),
  };
}

function parseRunningRecord(value: unknown): RunningRecord {
  if (!isRecord(value)) throw new Error("Invalid running review record.");
  exactKeys(value, ["version", "job", "attempt", "workerId", "leaseToken", "claimedAt", "leaseUntil"]);
  if (value.version !== SPOOL_RECORD_VERSION) throw new Error("Unsupported running review record version.");
  const claimedAt = isoTimestamp(value.claimedAt, "review claim timestamp");
  const leaseUntil = isoTimestamp(value.leaseUntil, "review lease timestamp");
  if (leaseUntil <= claimedAt) throw new Error("Invalid running review lease interval.");
  return {
    version: 1,
    job: parseReviewJob(value.job),
    attempt: positiveInteger(value.attempt, "running review attempt"),
    workerId: workerId(value.workerId),
    leaseToken: leaseToken(value.leaseToken),
    claimedAt,
    leaseUntil,
  };
}

function parseOutcomeRecord(value: unknown): OutcomeRecord {
  if (!isRecord(value)) throw new Error("Invalid review outcome record.");
  exactKeys(value, ["version", "attempt", "workerId", "leaseToken", "outcome"]);
  if (value.version !== SPOOL_RECORD_VERSION) throw new Error("Unsupported review outcome record version.");
  return {
    version: 1,
    attempt: positiveInteger(value.attempt, "review outcome attempt"),
    workerId: workerId(value.workerId),
    leaseToken: leaseToken(value.leaseToken),
    outcome: parseReviewOutcome(value.outcome),
  };
}

function boundedRecord(value: unknown, maxBytes: number, label: string): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`);
  return encoded;
}

function checkedLeaseMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_LEASE_MS || value > MAX_LEASE_MS) throw new Error("Invalid review lease duration.");
  return value;
}

function checkedDeferDelayMs(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid review defer delay.");
  return value;
}

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function emptyRecovery(): RecoveryResult {
  return { requeued: 0, quarantined: 0, cleaned: 0 };
}

/** Durable filesystem queue. SQLite, when supplied, is only a best-effort audit shadow. */
export class ReviewSpool {
  readonly root: string;
  readonly queuedDir: string;
  readonly runningDir: string;
  readonly outcomesDir: string;
  readonly deadLetterDir: string;

  private readonly lockPath: string;
  private readonly ledger?: ReviewLedger;
  private readonly clock: () => Date;
  private readonly onLedgerError?: (error: unknown) => void;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(root: string, options: ReviewSpoolOptions = {}) {
    if (!root) throw new Error("Review spool root is required.");
    this.root = resolve(root);
    this.queuedDir = join(this.root, "queued");
    this.runningDir = join(this.root, "running");
    this.outcomesDir = join(this.root, "outcomes");
    this.deadLetterDir = join(this.root, "dead-letter");
    this.lockPath = join(this.root, ".spool.lock");
    this.ledger = options.ledger;
    this.clock = options.now ?? (() => new Date());
    this.onLedgerError = options.onLedgerError;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
  }

  async initialize(): Promise<void> {
    await this.ensureLayout();
  }

  async enqueue(value: ReviewJob): Promise<EnqueueResult> {
    const job = decodeReviewJob(encodeReviewJob(value));
    return this.lock(async () => {
      const existing = await this.findIdentity(job.id);
      if (existing) {
        if (existing.digest !== job.digest) {
          await this.quarantineIncoming(job, existing.digest);
          return "quarantined";
        }
        this.shadow(() => this.ledger?.recordJob(job, this.nowIso()));
        return "duplicate";
      }
      const record: QueueRecord = { version: 1, job, nextAttempt: 1 };
      await this.writeRecord(this.queuePath(job.id), record, MAX_QUEUE_RECORD_BYTES, "Queued review record");
      this.shadow(() => this.ledger?.recordJob(job, this.nowIso()));
      return "enqueued";
    });
  }

  async claim(options: ClaimOptions): Promise<ReviewClaim | undefined> {
    const owner = workerId(options.workerId);
    const duration = checkedLeaseMs(options.leaseMs);
    return this.lock(async () => {
      const at = this.now();
      await this.recoverUnlocked(at);
      const names = await this.recordNames(this.queuedDir);
      for (const name of names) {
        const path = join(this.queuedDir, name);
        let queued: QueueRecord;
        try {
          queued = await this.readQueue(path);
          if (name !== `${queued.job.id}.json`) throw new Error("Queued review filename does not match job id.");
        } catch {
          await this.quarantineFile(path);
          continue;
        }

        const outcome = await this.readOutcomeIfPresent(queued.job.id);
        if (outcome) {
          if (outcome.outcome.jobDigest === queued.job.digest) await this.remove(path);
          else await this.quarantineFile(path);
          continue;
        }
        const running = await this.readRunningIfPresent(queued.job.id);
        if (running) {
          if (running.job.digest === queued.job.digest) await this.remove(path);
          else await this.quarantineFile(path);
          continue;
        }

        if (queued.availableAt && queued.availableAt > at.toISOString()) continue;

        const claimedAt = this.now();
        const claim: RunningRecord = {
          version: 1,
          job: queued.job,
          attempt: queued.nextAttempt,
          workerId: owner,
          leaseToken: randomBytes(16).toString("hex"),
          claimedAt: claimedAt.toISOString(),
          leaseUntil: new Date(claimedAt.getTime() + duration).toISOString(),
        };
        await this.writeRecord(this.runningPath(claim.job.id), claim, MAX_RUNNING_RECORD_BYTES, "Running review record");
        await this.remove(path);
        this.shadow(() => this.ledger?.recordClaim(claim));
        return this.publicClaim(claim);
      }
      return undefined;
    });
  }

  async renew(value: ReviewClaim, leaseMs: number): Promise<ReviewClaim> {
    const duration = checkedLeaseMs(leaseMs);
    return this.lock(async () => {
      const claim = await this.requireCurrentClaim(value, true);
      const now = this.now();
      const renewed: RunningRecord = {
        ...claim,
        leaseUntil: new Date(now.getTime() + duration).toISOString(),
      };
      if (renewed.leaseUntil <= claim.claimedAt) throw new Error("Invalid renewed review lease interval.");
      await this.writeRecord(this.runningPath(claim.job.id), renewed, MAX_RUNNING_RECORD_BYTES, "Running review record");
      this.shadow(() => {
        this.ledger?.recordClaim(renewed);
        this.ledger?.recordRenewal(renewed);
      });
      return this.publicClaim(renewed);
    });
  }

  async defer(value: ReviewClaim, options: DeferOptions = {}): Promise<DeferResult> {
    const delayMs = checkedDeferDelayMs(options.delayMs);
    return this.lock(async () => {
      const claim = await this.requireCurrentClaim(value, true);
      const now = this.now();
      const availableAt = new Date(now.getTime() + delayMs);
      if (!Number.isFinite(availableAt.getTime())) throw new Error("Invalid review defer delay.");
      const queued: QueueRecord = {
        version: 1,
        job: claim.job,
        nextAttempt: claim.attempt + 1,
        ...(delayMs > 0 ? { availableAt: availableAt.toISOString() } : {}),
      };
      await this.writeRecord(this.queuePath(claim.job.id), queued, MAX_QUEUE_RECORD_BYTES, "Queued review record");
      await this.remove(this.runningPath(claim.job.id));
      return "deferred" as const;
    });
  }

  async finish(value: ReviewClaim, result: ReviewOutcome): Promise<FinishResult> {
    const supplied = this.validateClaim(value);
    const outcome = decodeReviewOutcome(encodeReviewOutcome(result));
    if (outcome.jobId !== supplied.job.id || outcome.jobDigest !== supplied.job.digest) {
      throw new ReviewSpoolConflictError("Review outcome does not match claimed job.");
    }
    return this.lock(async () => {
      const prior = await this.readOutcomeIfPresent(outcome.jobId);
      if (prior) {
        if (prior.leaseToken !== supplied.leaseToken || prior.attempt !== supplied.attempt) throw new ReviewLeaseError();
        if (encodeReviewOutcome(prior.outcome) !== encodeReviewOutcome(outcome)) {
          throw new ReviewSpoolConflictError("Conflicting outcome for completed review claim.");
        }
        this.shadow(() => {
          this.ledger?.recordClaim(supplied);
          this.ledger?.recordOutcome(supplied, outcome);
        });
        return "duplicate";
      }
      const claim = await this.requireCurrentClaim(supplied, true);
      const record: OutcomeRecord = {
        version: 1,
        attempt: claim.attempt,
        workerId: claim.workerId,
        leaseToken: claim.leaseToken,
        outcome,
      };
      await this.writeRecord(this.outcomePath(claim.job.id), record, MAX_OUTCOME_RECORD_BYTES, "Review outcome record");
      await this.remove(this.runningPath(claim.job.id));
      await this.remove(this.queuePath(claim.job.id));
      this.shadow(() => {
        this.ledger?.recordClaim(claim);
        this.ledger?.recordOutcome(claim, outcome);
      });
      return "finished";
    });
  }

  async activeClaims(at = this.now()): Promise<ReviewClaim[]> {
    if (!Number.isFinite(at.getTime())) throw new Error("Invalid review active-claim time.");
    return this.lock(async () => {
      await this.recoverUnlocked(at);
      const claims: ReviewClaim[] = [];
      for (const name of await this.recordNames(this.runningDir)) {
        const path = join(this.runningDir, name);
        try {
          const running = await this.readRunning(path);
          if (name !== `${running.job.id}.json`) throw new Error("Running review filename does not match job id.");
          claims.push(this.publicClaim(running));
        } catch {
          await this.quarantineFile(path);
        }
      }
      return claims;
    });
  }

  async getOutcome(jobId: string): Promise<ReviewOutcome | undefined> {
    if (!/^review_[0-9a-f]{40}$/u.test(jobId)) throw new Error("Invalid review job id.");
    return this.lock(async () => (await this.readOutcomeIfPresent(jobId))?.outcome);
  }

  async purgeTerminalBefore(cutoff: Date): Promise<number> {
    if (!Number.isFinite(cutoff.getTime())) throw new Error("Invalid review spool retention cutoff.");
    return this.lock(async () => {
      let removed = 0;
      for (const dir of [this.outcomesDir, this.deadLetterDir]) {
        for (const name of await readdir(dir)) {
          const path = join(dir, name);
          const info = await stat(path).catch(() => undefined);
          if (!info?.isFile() || info.mtimeMs >= cutoff.getTime()) continue;
          await this.remove(path);
          removed += 1;
        }
      }
      return removed;
    });
  }

  async recover(at = this.now()): Promise<RecoveryResult> {
    if (!Number.isFinite(at.getTime())) throw new Error("Invalid review recovery time.");
    return this.lock(() => this.recoverUnlocked(at));
  }

  private async recoverUnlocked(at: Date): Promise<RecoveryResult> {
    const result = emptyRecovery();
    for (const name of await this.recordNames(this.outcomesDir)) {
      const path = join(this.outcomesDir, name);
      try {
        const record = await this.readOutcome(path);
        if (name !== `${record.outcome.jobId}.json`) throw new Error("Review outcome filename does not match job id.");
      } catch {
        await this.quarantineFile(path);
        result.quarantined += 1;
      }
    }

    for (const name of await this.recordNames(this.runningDir)) {
      const path = join(this.runningDir, name);
      let running: RunningRecord;
      try {
        running = await this.readRunning(path);
        if (name !== `${running.job.id}.json`) throw new Error("Running review filename does not match job id.");
      } catch {
        await this.quarantineFile(path);
        result.quarantined += 1;
        continue;
      }
      const outcome = await this.readOutcomeIfPresent(running.job.id);
      if (outcome) {
        if (outcome.outcome.jobDigest === running.job.digest) {
          await this.remove(path);
          result.cleaned += 1;
        } else {
          await this.quarantineFile(path);
          result.quarantined += 1;
        }
        continue;
      }
      let queued = await this.readQueueIfPresent(running.job.id);
      if (queued && queued.job.digest !== running.job.digest) {
        await this.quarantineFile(this.queuePath(running.job.id));
        result.quarantined += 1;
        queued = undefined;
      }
      // Queue-first defer is crash-atomic: a higher fenced attempt proves the
      // durable defer committed, even if removing the running record did not.
      if (queued && queued.nextAttempt > running.attempt) {
        await this.remove(path);
        result.cleaned += 1;
        continue;
      }
      if (running.leaseUntil > at.toISOString()) continue;

      const record: QueueRecord = {
        version: 1,
        job: running.job,
        nextAttempt: Math.max(running.attempt + 1, queued?.nextAttempt ?? 1),
      };
      await this.writeRecord(this.queuePath(running.job.id), record, MAX_QUEUE_RECORD_BYTES, "Queued review record");
      await this.remove(path);
      this.shadow(() => {
        this.ledger?.recordClaim(running);
        this.ledger?.recordRecovery(running, at.toISOString());
      });
      result.requeued += 1;
    }

    for (const name of await this.recordNames(this.queuedDir)) {
      const path = join(this.queuedDir, name);
      let queued: QueueRecord;
      try {
        queued = await this.readQueue(path);
        if (name !== `${queued.job.id}.json`) throw new Error("Queued review filename does not match job id.");
      } catch {
        await this.quarantineFile(path);
        result.quarantined += 1;
        continue;
      }
      const outcome = await this.readOutcomeIfPresent(queued.job.id);
      if (outcome) {
        if (outcome.outcome.jobDigest === queued.job.digest) {
          await this.remove(path);
          result.cleaned += 1;
        } else {
          await this.quarantineFile(path);
          result.quarantined += 1;
        }
        continue;
      }
      const running = await this.readRunningIfPresent(queued.job.id);
      if (running) {
        if (running.job.digest === queued.job.digest) {
          await this.remove(path);
          result.cleaned += 1;
        } else {
          await this.quarantineFile(path);
          result.quarantined += 1;
        }
      }
    }
    return result;
  }

  private async requireCurrentClaim(value: ReviewClaim, requireLive: boolean): Promise<RunningRecord> {
    const supplied = this.validateClaim(value);
    const current = await this.readRunningIfPresent(supplied.job.id);
    if (!current
      || current.job.digest !== supplied.job.digest
      || current.attempt !== supplied.attempt
      || current.workerId !== supplied.workerId
      || current.leaseToken !== supplied.leaseToken) throw new ReviewLeaseError();
    if (requireLive && current.leaseUntil <= this.nowIso()) throw new ReviewLeaseError();
    return current;
  }

  private validateClaim(value: ReviewClaim): ReviewClaim {
    if (!isRecord(value)) throw new ReviewLeaseError();
    const job = decodeReviewJob(encodeReviewJob(value.job));
    const attempt = positiveInteger(value.attempt, "review claim attempt");
    const owner = workerId(value.workerId);
    const token = leaseToken(value.leaseToken);
    const claimedAt = isoTimestamp(value.claimedAt, "review claim timestamp");
    const leaseUntil = isoTimestamp(value.leaseUntil, "review lease timestamp");
    if (leaseUntil <= claimedAt) throw new ReviewLeaseError();
    return { job, attempt, workerId: owner, leaseToken: token, claimedAt, leaseUntil };
  }

  private publicClaim(value: RunningRecord): ReviewClaim {
    return {
      job: value.job,
      attempt: value.attempt,
      workerId: value.workerId,
      leaseToken: value.leaseToken,
      claimedAt: value.claimedAt,
      leaseUntil: value.leaseUntil,
    };
  }

  private async findIdentity(jobId: string): Promise<{ digest: string } | undefined> {
    const outcome = await this.readOutcomeIfPresent(jobId);
    if (outcome) return { digest: outcome.outcome.jobDigest };
    const running = await this.readRunningIfPresent(jobId);
    if (running) return { digest: running.job.digest };
    const queued = await this.readQueueIfPresent(jobId);
    return queued ? { digest: queued.job.digest } : undefined;
  }

  private async quarantineIncoming(job: ReviewJob, existingDigest: string): Promise<void> {
    const record = {
      version: 1,
      reason: "digest-conflict",
      quarantinedAt: this.nowIso(),
      existingDigest,
      job,
    };
    const path = join(this.deadLetterDir, `${job.id}.${job.digest.slice(0, 12)}.${randomUUID()}.json`);
    await this.writeRecord(path, record, MAX_DEAD_LETTER_BYTES, "Review dead-letter record");
  }

  private async quarantineFile(path: string): Promise<void> {
    const safeName = basename(path).replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 160);
    const target = join(this.deadLetterDir, `${safeName}.${Date.now()}.${randomUUID()}.bad`);
    try {
      await rename(path, target);
      await chmod(target, 0o600);
      await this.syncDirectory(dirname(path));
      if (dirname(target) !== dirname(path)) await this.syncDirectory(dirname(target));
    } catch (error) {
      if (!errno(error, "ENOENT")) throw error;
    }
  }

  private async readQueueIfPresent(jobId: string): Promise<QueueRecord | undefined> {
    try {
      return await this.readQueue(this.queuePath(jobId));
    } catch (error) {
      if (errno(error, "ENOENT")) return undefined;
      await this.quarantineFile(this.queuePath(jobId));
      return undefined;
    }
  }

  private async readRunningIfPresent(jobId: string): Promise<RunningRecord | undefined> {
    try {
      return await this.readRunning(this.runningPath(jobId));
    } catch (error) {
      if (errno(error, "ENOENT")) return undefined;
      await this.quarantineFile(this.runningPath(jobId));
      return undefined;
    }
  }

  private async readOutcomeIfPresent(jobId: string): Promise<OutcomeRecord | undefined> {
    try {
      return await this.readOutcome(this.outcomePath(jobId));
    } catch (error) {
      if (errno(error, "ENOENT")) return undefined;
      await this.quarantineFile(this.outcomePath(jobId));
      return undefined;
    }
  }

  private async readQueue(path: string): Promise<QueueRecord> {
    return parseQueueRecord(JSON.parse(await this.readBounded(path, MAX_QUEUE_RECORD_BYTES)) as unknown);
  }

  private async readRunning(path: string): Promise<RunningRecord> {
    return parseRunningRecord(JSON.parse(await this.readBounded(path, MAX_RUNNING_RECORD_BYTES)) as unknown);
  }

  private async readOutcome(path: string): Promise<OutcomeRecord> {
    return parseOutcomeRecord(JSON.parse(await this.readBounded(path, MAX_OUTCOME_RECORD_BYTES)) as unknown);
  }

  private async readBounded(path: string, maxBytes: number): Promise<string> {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Review spool record must be a regular file.");
      if (info.size === 0) throw new Error("Review spool record is empty.");
      if (info.size > maxBytes) throw new Error(`Review spool record exceeds ${maxBytes} bytes.`);
      const content = await handle.readFile();
      if (content.byteLength > maxBytes) throw new Error(`Review spool record exceeds ${maxBytes} bytes.`);
      return content.toString("utf8");
    } finally {
      await handle.close();
    }
  }

  private async writeRecord(path: string, value: unknown, maxBytes: number, label: string): Promise<void> {
    const encoded = boundedRecord(value, maxBytes, label);
    await atomicWriteFile(path, encoded);
    await chmod(path, 0o600);
  }

  private async recordNames(dir: string): Promise<string[]> {
    const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
    if (names.length > MAX_DIRECTORY_FILES) throw new Error(`Review spool directory exceeds ${MAX_DIRECTORY_FILES} records.`);
    return names;
  }

  private async ensureLayout(): Promise<void> {
    for (const dir of [this.root, this.queuedDir, this.runningDir, this.outcomesDir, this.deadLetterDir]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Review spool path must be a regular directory.");
      await chmod(dir, 0o700);
    }
  }

  private async lock<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureLayout();
    return withFileLock(this.lockPath, this.lockTimeoutMs, this.staleLockMs, "review spool", fn);
  }

  private now(): Date {
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) throw new Error("Invalid review spool clock.");
    return now;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private shadow(fn: () => void): void {
    if (!this.ledger) return;
    try {
      fn();
    } catch (error) {
      try {
        this.onLedgerError?.(error);
      } catch {
        // Observability must never become queue authority.
      }
    }
  }

  private queuePath(jobId: string): string {
    return join(this.queuedDir, `${jobId}.json`);
  }

  private runningPath(jobId: string): string {
    return join(this.runningDir, `${jobId}.json`);
  }

  private outcomePath(jobId: string): string {
    return join(this.outcomesDir, `${jobId}.json`);
  }

  private async remove(path: string): Promise<void> {
    let removed = true;
    await unlink(path).catch((error) => {
      if (errno(error, "ENOENT")) removed = false;
      else throw error;
    });
    if (!removed) return;
    await this.syncDirectory(dirname(path));
  }

  private async syncDirectory(path: string): Promise<void> {
    const directory = await open(path, "r").catch(() => undefined);
    if (!directory) return;
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
