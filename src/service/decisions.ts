import { constants, type Dirent } from "node:fs";
import { lstat, mkdir, open, readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { withFileLock } from "../file-lock.ts";
import type { ReviewOperation } from "../types.ts";
import { admissionJsonDigest, createOrCompareJsonFile } from "./admission-transaction.ts";
import {
  createReviewOutcome,
  parseReviewJob,
  parseReviewOutcome,
  type ReviewFailure,
  type ReviewJob,
  type ReviewModelProvenance,
  type ReviewOutcome,
} from "./protocol.ts";

export const MAX_REVIEW_ATTEMPT_CHECKPOINT_BYTES = 192 * 1024;
export const MAX_REVIEW_PROPOSAL_DECISION_BYTES = 192 * 1024;
export const MAX_REVIEW_DECISION_RETENTION_ENTRIES = 20_000;

const VERSION = 1 as const;
const JOB_ID = /^review_[0-9a-f]{40}$/u;
const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TEMPORARY = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;

export type CompletedReviewOutcome = Extract<ReviewOutcome, { status: "completed" }>;

export type ReviewProviderResult =
  | {
    status: "completed";
    completedAt: string;
    operations: ReviewOperation[];
    provenance: ReviewModelProvenance;
  }
  | {
    status: "failed";
    completedAt: string;
    error: ReviewFailure;
    provenance?: ReviewModelProvenance;
  };

export interface ReviewAttemptCheckpoint {
  readonly version: typeof VERSION;
  readonly kind: "review-provider-result";
  readonly attemptId: string;
  readonly proposalDigest: string | null;
  readonly job: ReviewJob;
  readonly outcome: ReviewOutcome;
}

export interface ReviewProposalDecision {
  readonly version: typeof VERSION;
  readonly kind: "review-proposal-decision";
  readonly attemptId: string;
  readonly proposalDigest: string;
  readonly job: ReviewJob;
  readonly outcome: CompletedReviewOutcome;
}

export type ReviewAttemptDisposition = "selected" | "accounted" | "replayed";

export interface ReviewAttemptDecision {
  readonly disposition: ReviewAttemptDisposition;
  readonly attempt: ReviewAttemptCheckpoint;
  readonly decision?: ReviewProposalDecision;
}

export interface ReviewDecisionStoreOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export class ReviewDecisionConflictError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ReviewDecisionConflictError";
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  const allowed = new Set(expected);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    throw new Error("Invalid review decision object shape.");
  }
}

function requireJobId(value: string): string {
  if (typeof value !== "string" || !JOB_ID.test(value)) throw new Error("Invalid review decision job ID.");
  return value;
}

function requireAttemptId(value: unknown): string {
  if (typeof value !== "string" || !ATTEMPT_ID.test(value)) throw new Error("Invalid review attempt ID.");
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`Invalid ${label} digest.`);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function proposalDigest(outcome: CompletedReviewOutcome): string {
  return admissionJsonDigest({
    version: VERSION,
    jobId: outcome.jobId,
    jobDigest: outcome.jobDigest,
    operations: outcome.operations,
  });
}

/** Strictly validates an immutable provider-result checkpoint and all identity bindings. */
export function parseReviewAttemptCheckpoint(value: unknown): ReviewAttemptCheckpoint {
  if (!isRecord(value)) throw new Error("Invalid review provider-result checkpoint.");
  exactKeys(value, ["version", "kind", "attemptId", "proposalDigest", "job", "outcome"]);
  if (value.version !== VERSION || value.kind !== "review-provider-result") {
    throw new Error("Unsupported review provider-result checkpoint.");
  }
  const attemptId = requireAttemptId(value.attemptId);
  const job = parseReviewJob(value.job);
  const outcome = parseReviewOutcome(value.outcome);
  if (outcome.jobId !== job.id || outcome.jobDigest !== job.digest) {
    throw new Error("Review provider result does not match its job.");
  }
  const expected = outcome.status === "completed" ? proposalDigest(outcome) : null;
  if (value.proposalDigest !== expected) throw new Error("Review provider-result proposal digest does not match its outcome.");
  return deepFreeze({
    version: VERSION,
    kind: "review-provider-result",
    attemptId,
    proposalDigest: expected,
    job,
    outcome,
  });
}

/** Strictly validates a complete elected proposal suitable for crash recovery. */
export function parseReviewProposalDecision(value: unknown): ReviewProposalDecision {
  if (!isRecord(value)) throw new Error("Invalid review proposal decision.");
  exactKeys(value, ["version", "kind", "attemptId", "proposalDigest", "job", "outcome"]);
  if (value.version !== VERSION || value.kind !== "review-proposal-decision") {
    throw new Error("Unsupported review proposal decision.");
  }
  const attemptId = requireAttemptId(value.attemptId);
  const job = parseReviewJob(value.job);
  const outcome = parseReviewOutcome(value.outcome);
  if (outcome.status !== "completed" || outcome.jobId !== job.id || outcome.jobDigest !== job.digest) {
    throw new Error("Review proposal decision requires a matching completed outcome.");
  }
  const digest = requireDigest(value.proposalDigest, "review proposal");
  if (digest !== proposalDigest(outcome)) throw new Error("Review proposal decision digest does not match its outcome.");
  return deepFreeze({ version: VERSION, kind: "review-proposal-decision", attemptId, proposalDigest: digest, job, outcome });
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const directoryOnly = "O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow | directoryOnly);
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error(`Review decision path is not a directory: ${path}`);
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableUnlink(path: string): Promise<boolean> {
  try {
    await unlink(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
  await syncDirectory(dirname(path));
  return true;
}

async function durableRmdir(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTEMPTY")) return;
    throw error;
  }
  await syncDirectory(dirname(path));
}

async function boundedEntries(path: string): Promise<Dirent[]> {
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.length > MAX_REVIEW_DECISION_RETENTION_ENTRIES) {
    throw new Error(`Review decision retention scan exceeds ${MAX_REVIEW_DECISION_RETENTION_ENTRIES} entries: ${path}`);
  }
  return entries;
}

async function readBoundedPrivateJson(path: string, maxBytes: number): Promise<unknown> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const file = await open(path, constants.O_RDONLY | noFollow);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`Review decision record is not a regular file: ${path}`);
    if ((info.mode & 0o777) !== 0o600) throw new Error(`Review decision record must be a private 0600 file: ${path}`);
    if (info.size <= 0) throw new Error(`Review decision record is empty: ${path}`);
    if (info.size > maxBytes) throw new Error(`Review decision record exceeds ${maxBytes} bytes: ${path}`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) throw new Error(`Review decision record exceeds ${maxBytes} bytes: ${path}`);
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`Review decision record exceeds ${maxBytes} bytes: ${path}`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
  } finally {
    await file.close();
  }
}

/**
 * Filesystem-authoritative provider-result journal and one-winner election.
 * `root` is review-spool root; decisions embed complete normalized outcomes so
 * recovery never needs another provider call.
 */
export class ReviewDecisionStore {
  readonly root: string;
  readonly providerResultsDir: string;
  readonly proposalDecisionsDir: string;

  private readonly locksDir: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(reviewSpoolRoot: string, options: ReviewDecisionStoreOptions = {}) {
    if (!reviewSpoolRoot) throw new Error("Review spool root is required for decisions.");
    this.root = resolve(reviewSpoolRoot);
    this.providerResultsDir = join(this.root, "provider-results");
    this.proposalDecisionsDir = join(this.root, "proposal-decisions");
    this.locksDir = join(this.proposalDecisionsDir, ".locks");
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
  }

  async recordAttempt(attemptIdValue: string, jobValue: ReviewJob, result: ReviewProviderResult): Promise<ReviewAttemptDecision> {
    const attemptId = requireAttemptId(attemptIdValue);
    const job = parseReviewJob(jobValue);
    const outcome = createReviewOutcome(job, result);
    const digest = outcome.status === "completed" ? proposalDigest(outcome) : null;
    const attempt = parseReviewAttemptCheckpoint({
      version: VERSION,
      kind: "review-provider-result",
      attemptId,
      proposalDigest: digest,
      job,
      outcome,
    });

    return this.withJobLock(job.id, async () => {
      await ensurePrivateDirectory(this.attemptDirectory(job.id));
      let publication: "created" | "matching";
      try {
        publication = await createOrCompareJsonFile(
          this.attemptPath(job.id, attemptId),
          attempt,
          MAX_REVIEW_ATTEMPT_CHECKPOINT_BYTES,
        );
      } catch (error) {
        throw new ReviewDecisionConflictError(`Conflicting provider result for review attempt '${attemptId}'.`, { cause: error });
      }

      let decision = await this.readDecisionIfExists(job.id);
      let elected = false;
      if (decision && (decision.job.digest !== job.digest || decision.job.id !== job.id)) {
        throw new ReviewDecisionConflictError(`Conflicting proposal decision for review job '${job.id}'.`);
      }
      if (!decision && outcome.status === "completed") {
        const candidate = parseReviewProposalDecision({
          version: VERSION,
          kind: "review-proposal-decision",
          attemptId,
          proposalDigest: digest,
          job,
          outcome,
        });
        await createOrCompareJsonFile(
          this.decisionPath(job.id),
          candidate,
          MAX_REVIEW_PROPOSAL_DECISION_BYTES,
        );
        decision = await this.readDecision(job.id);
        elected = true;
      }

      const disposition: ReviewAttemptDisposition = elected
        ? "selected"
        : publication === "matching"
          ? "replayed"
          : decision?.attemptId === attemptId
          ? "selected"
          : "accounted";
      return deepFreeze({ disposition, attempt, ...(decision ? { decision } : {}) });
    });
  }

  async loadAttempt(jobIdValue: string, attemptIdValue: string): Promise<ReviewAttemptCheckpoint | undefined> {
    const jobId = requireJobId(jobIdValue);
    const attemptId = requireAttemptId(attemptIdValue);
    return this.withJobLock(jobId, async () => {
      try {
        return parseReviewAttemptCheckpoint(
          await readBoundedPrivateJson(this.attemptPath(jobId, attemptId), MAX_REVIEW_ATTEMPT_CHECKPOINT_BYTES),
        );
      } catch (error) {
        if (isErrno(error, "ENOENT")) return undefined;
        throw error;
      }
    });
  }

  async loadDecision(jobIdValue: string): Promise<ReviewProposalDecision | undefined> {
    const jobId = requireJobId(jobIdValue);
    return this.withJobLock(jobId, () => this.readDecisionIfExists(jobId));
  }

  /** Purges old authority only for jobs the caller has established are terminal. */
  async purgeTerminalBefore(cutoff: Date, protectedJobIds: Iterable<string>): Promise<number> {
    if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) {
      throw new Error("Invalid review decision retention cutoff.");
    }
    if (protectedJobIds === null || protectedJobIds === undefined || typeof protectedJobIds[Symbol.iterator] !== "function") {
      throw new Error("Review decision retention requires protected job IDs.");
    }
    const protectedIds = new Set<string>();
    for (const jobId of protectedJobIds) protectedIds.add(requireJobId(jobId));
    const cutoffMs = cutoff.getTime();
    await this.ensureLayout();

    const jobs = new Set<string>();
    let removed = 0;
    for (const entry of await boundedEntries(this.proposalDecisionsDir)) {
      if (entry.name === ".locks") continue;
      const path = join(this.proposalDecisionsDir, entry.name);
      if (TEMPORARY.test(entry.name)) {
        const info = await lstat(path).catch((error: unknown) => {
          if (isErrno(error, "ENOENT")) return undefined;
          throw error;
        });
        if (!info) continue;
        if (!info.isFile()) throw new Error(`Review decision temporary is not a regular file: ${path}`);
        if (info.mtimeMs < cutoffMs && await durableUnlink(path)) removed += 1;
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        throw new Error(`Unexpected review decision retention entry: ${path}`);
      }
      jobs.add(requireJobId(entry.name.slice(0, -5)));
    }
    for (const entry of await boundedEntries(this.providerResultsDir)) {
      const path = join(this.providerResultsDir, entry.name);
      if (!entry.isDirectory()) throw new Error(`Unexpected review provider-result retention entry: ${path}`);
      jobs.add(requireJobId(entry.name));
    }

    for (const jobId of [...jobs].sort()) {
      if (protectedIds.has(jobId)) continue;
      removed += await this.withJobLock(jobId, () => this.purgeJobBefore(jobId, cutoffMs));
    }
    return removed;
  }

  private async purgeJobBefore(jobId: string, cutoffMs: number): Promise<number> {
    const attemptDirectory = this.attemptDirectory(jobId);
    let attemptDirectoryExists = false;
    let attemptEntries: Awaited<ReturnType<typeof boundedEntries>> = [];
    try {
      const info = await lstat(attemptDirectory);
      if (!info.isDirectory()) throw new Error(`Review provider-result path is not a directory: ${attemptDirectory}`);
      if ((info.mode & 0o777) !== 0o700) throw new Error(`Review provider-result path must be private 0700: ${attemptDirectory}`);
      attemptDirectoryExists = true;
      attemptEntries = await boundedEntries(attemptDirectory);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }

    // Validate every old authority record before deleting any record for this job.
    const attemptDeletions: string[] = [];
    for (const entry of attemptEntries) {
      const path = join(attemptDirectory, entry.name);
      if (TEMPORARY.test(entry.name)) {
        const info = await lstat(path);
        if (!info.isFile()) throw new Error(`Review provider-result temporary is not a regular file: ${path}`);
        if (info.mtimeMs < cutoffMs) attemptDeletions.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        throw new Error(`Unexpected review provider-result retention entry: ${path}`);
      }
      const attemptId = requireAttemptId(entry.name.slice(0, -5));
      const info = await lstat(path);
      if (!info.isFile()) throw new Error(`Review provider-result record is not a regular file: ${path}`);
      if (info.mtimeMs >= cutoffMs) continue;
      const attempt = parseReviewAttemptCheckpoint(
        await readBoundedPrivateJson(path, MAX_REVIEW_ATTEMPT_CHECKPOINT_BYTES),
      );
      if (attempt.job.id !== jobId || attempt.attemptId !== attemptId) {
        throw new Error("Review provider-result filename does not match its job or attempt.");
      }
      attemptDeletions.push(path);
    }

    const decisionPath = this.decisionPath(jobId);
    let decisionDeletion = false;
    try {
      const info = await lstat(decisionPath);
      if (!info.isFile()) throw new Error(`Review proposal decision is not a regular file: ${decisionPath}`);
      if (info.mtimeMs < cutoffMs) {
        await this.readDecision(jobId);
        decisionDeletion = true;
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }

    let removed = 0;
    for (const path of attemptDeletions) {
      if (await durableUnlink(path)) removed += 1;
    }
    if (decisionDeletion && await durableUnlink(decisionPath)) removed += 1;
    if (attemptDirectoryExists) {
      const remaining = await boundedEntries(attemptDirectory).catch((error: unknown) => {
        if (isErrno(error, "ENOENT")) return [];
        throw error;
      });
      if (remaining.length === 0) await durableRmdir(attemptDirectory);
    }
    return removed;
  }

  private async ensureLayout(): Promise<void> {
    for (const directory of [this.root, this.providerResultsDir, this.proposalDecisionsDir, this.locksDir]) {
      await ensurePrivateDirectory(directory);
    }
  }

  private async withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
    await this.ensureLayout();
    return withFileLock(
      join(this.locksDir, `${jobId}.lock`),
      this.lockTimeoutMs,
      this.staleLockMs,
      `review proposal decision ${jobId}`,
      fn,
    );
  }

  private async readDecisionIfExists(jobId: string): Promise<ReviewProposalDecision | undefined> {
    try {
      return await this.readDecision(jobId);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async readDecision(jobId: string): Promise<ReviewProposalDecision> {
    const decision = parseReviewProposalDecision(
      await readBoundedPrivateJson(this.decisionPath(jobId), MAX_REVIEW_PROPOSAL_DECISION_BYTES),
    );
    if (decision.job.id !== jobId) throw new Error("Review proposal decision filename does not match its job.");
    return decision;
  }

  private attemptDirectory(jobId: string): string {
    return join(this.providerResultsDir, requireJobId(jobId));
  }

  private attemptPath(jobId: string, attemptId: string): string {
    return join(this.attemptDirectory(jobId), `${requireAttemptId(attemptId)}.json`);
  }

  private decisionPath(jobId: string): string {
    return join(this.proposalDecisionsDir, `${requireJobId(jobId)}.json`);
  }
}
