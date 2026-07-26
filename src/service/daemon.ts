import { hostname } from "node:os";
import { readFile } from "node:fs/promises";

import { atomicWriteFile } from "../atomic-file.ts";
import { withFileLock } from "../file-lock.ts";
import { ModelRunError, type ReviewModelProvenance } from "./model-runner.ts";
import type { AdmissionReceipt, ProposalCommitter } from "./admission.ts";
import { createReviewOutcome, sanitizeReviewText, type ReviewFailure } from "./protocol.ts";
import { ReviewEngine, ReviewEngineError, type ReviewProposal } from "./review-engine.ts";
import type { ReviewClaim, ReviewSpool } from "./spool.ts";

export const DEFAULT_REVIEW_LEASE_MS = 5 * 60_000;
export const DEFAULT_REVIEW_POLL_MS = 5_000;
export const DEFAULT_REVIEW_MAX_ATTEMPTS = 3;

export interface ReviewDailyBudgetLimits {
  maxCalls: number;
  maxTokens: number;
  maxCostUsd: number;
}

export interface ReviewBudgetUsage {
  day: string;
  calls: number;
  tokens: number;
  costUsd: number;
}

export interface ReviewBudgetAccount {
  snapshot(): Promise<ReviewBudgetUsage>;
  reserveCall(limits: ReviewDailyBudgetLimits): Promise<ReviewBudgetUsage | undefined>;
  releaseCall(): Promise<ReviewBudgetUsage>;
  charge(provenance: ReviewModelProvenance): Promise<ReviewBudgetUsage>;
}

interface StoredBudget {
  version: 1;
  day: string;
  calls: number;
  tokens: number;
  costUsd: number;
}

function utcDay(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("Invalid review budget clock.");
  return value.toISOString().slice(0, 10);
}

function emptyBudget(day: string): StoredBudget {
  return { version: 1, day, calls: 0, tokens: 0, costUsd: 0 };
}

function publicBudget(value: ReviewBudgetUsage): ReviewBudgetUsage {
  return { day: value.day, calls: value.calls, tokens: value.tokens, costUsd: value.costUsd };
}

function parseBudget(value: unknown, day: string): StoredBudget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid review budget record.");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.day !== "string") throw new Error("Invalid review budget record.");
  for (const key of ["calls", "tokens", "costUsd"] as const) {
    if (typeof record[key] !== "number" || !Number.isFinite(record[key]) || record[key] < 0) {
      throw new Error("Invalid review budget record.");
    }
  }
  if (!Number.isSafeInteger(record.calls) || !Number.isSafeInteger(record.tokens)) {
    throw new Error("Invalid review budget record.");
  }
  if (record.day !== day) return emptyBudget(day);
  return {
    version: 1,
    day,
    calls: record.calls as number,
    tokens: record.tokens as number,
    costUsd: record.costUsd as number,
  };
}

function checkedLimits(value: ReviewDailyBudgetLimits): ReviewDailyBudgetLimits {
  if (!Number.isSafeInteger(value.maxCalls) || value.maxCalls < 1) throw new Error("Invalid daily review call budget.");
  if (!Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1) throw new Error("Invalid daily review token budget.");
  if (!Number.isFinite(value.maxCostUsd) || value.maxCostUsd <= 0) throw new Error("Invalid daily review cost budget.");
  return { ...value };
}

function mayStart(usage: ReviewBudgetUsage, limits: ReviewDailyBudgetLimits): boolean {
  return usage.calls < limits.maxCalls && usage.tokens < limits.maxTokens && usage.costUsd < limits.maxCostUsd;
}

/** Process-local budget adapter, useful for one-shot workers and tests. */
export class InMemoryReviewBudgetAccount implements ReviewBudgetAccount {
  private usage: ReviewBudgetUsage;
  private readonly clock: () => Date;

  constructor(options: { now?: () => Date; initial?: ReviewBudgetUsage } = {}) {
    this.clock = options.now ?? (() => new Date());
    const day = utcDay(this.clock());
    this.usage = options.initial?.day === day
      ? publicBudget(options.initial)
      : publicBudget(emptyBudget(day));
  }

  async snapshot(): Promise<ReviewBudgetUsage> {
    this.rollover();
    return publicBudget(this.usage);
  }

  async reserveCall(limits: ReviewDailyBudgetLimits): Promise<ReviewBudgetUsage | undefined> {
    this.rollover();
    const checked = checkedLimits(limits);
    if (!mayStart(this.usage, checked)) return undefined;
    this.usage.calls += 1;
    return publicBudget(this.usage);
  }

  async releaseCall(): Promise<ReviewBudgetUsage> {
    this.rollover();
    this.usage.calls = Math.max(0, this.usage.calls - 1);
    return publicBudget(this.usage);
  }

  async charge(provenance: ReviewModelProvenance): Promise<ReviewBudgetUsage> {
    this.rollover();
    this.usage.tokens += Math.max(0, Math.floor(provenance.usage.totalTokens));
    this.usage.costUsd += Math.max(0, provenance.usage.cost.total);
    return publicBudget(this.usage);
  }

  private rollover(): void {
    const day = utcDay(this.clock());
    if (this.usage.day !== day) this.usage = publicBudget(emptyBudget(day));
  }
}

/** Locked, atomic daily budget accounting shared by CLI/daemon restarts. */
export class FileReviewBudgetAccount implements ReviewBudgetAccount {
  readonly path: string;
  private readonly lockPath: string;
  private readonly clock: () => Date;

  constructor(path: string, options: { now?: () => Date } = {}) {
    if (!path) throw new Error("Review budget path is required.");
    this.path = path;
    this.lockPath = `${path}.lock`;
    this.clock = options.now ?? (() => new Date());
  }

  snapshot(): Promise<ReviewBudgetUsage> {
    return this.lock(async () => publicBudget(await this.readCurrent()));
  }

  reserveCall(limits: ReviewDailyBudgetLimits): Promise<ReviewBudgetUsage | undefined> {
    return this.lock(async () => {
      const usage = await this.readCurrent();
      const checked = checkedLimits(limits);
      if (!mayStart(usage, checked)) return undefined;
      usage.calls += 1;
      await this.write(usage);
      return publicBudget(usage);
    });
  }

  releaseCall(): Promise<ReviewBudgetUsage> {
    return this.lock(async () => {
      const usage = await this.readCurrent();
      usage.calls = Math.max(0, usage.calls - 1);
      await this.write(usage);
      return publicBudget(usage);
    });
  }

  charge(provenance: ReviewModelProvenance): Promise<ReviewBudgetUsage> {
    return this.lock(async () => {
      const usage = await this.readCurrent();
      usage.tokens += Math.max(0, Math.floor(provenance.usage.totalTokens));
      usage.costUsd += Math.max(0, provenance.usage.cost.total);
      await this.write(usage);
      return publicBudget(usage);
    });
  }

  private async readCurrent(): Promise<StoredBudget> {
    const day = utcDay(this.clock());
    try {
      const encoded = await readFile(this.path, "utf8");
      if (Buffer.byteLength(encoded, "utf8") > 4_096) throw new Error("Review budget record is oversized.");
      return parseBudget(JSON.parse(encoded) as unknown, day);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyBudget(day);
      }
      throw error;
    }
  }

  private write(value: StoredBudget): Promise<void> {
    return atomicWriteFile(this.path, `${JSON.stringify(value)}\n`);
  }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.lockPath, 5_000, 30_000, "review budget", fn);
  }
}

export type ReviewDaemonEvent =
  | { type: "claimed"; jobId: string; attempt: number }
  | { type: "completed"; jobId: string; attempt: number; provenance: ReviewModelProvenance; admission?: AdmissionReceipt }
  | { type: "retry"; jobId: string; attempt: number; failure: ReviewFailure }
  | { type: "failed"; jobId: string; attempt: number; failure: ReviewFailure }
  | { type: "budget_exhausted"; usage: ReviewBudgetUsage }
  | { type: "idle" };

export interface ReviewSpoolAdapter {
  initialize(): Promise<void>;
  recover(): Promise<unknown>;
  claim(options: { workerId: string; leaseMs: number }): Promise<ReviewClaim | undefined>;
  renew(claim: ReviewClaim, leaseMs: number): Promise<ReviewClaim>;
  finish(claim: ReviewClaim, outcome: ReturnType<typeof createReviewOutcome>): Promise<unknown>;
}

export interface ReviewDaemonOptions {
  spool: ReviewSpoolAdapter | ReviewSpool;
  engine: ReviewEngine;
  budget: ReviewDailyBudgetLimits;
  budgetAccount?: ReviewBudgetAccount;
  workerId?: string;
  leaseMs?: number;
  pollMs?: number;
  maxAttempts?: number;
  onEvent?: (event: ReviewDaemonEvent) => void;
  committer?: ProposalCommitter;
  maintenance?: () => Promise<void>;
  maintenanceIntervalMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type ReviewWorkResult =
  | { status: "completed"; proposal: ReviewProposal; admission?: AdmissionReceipt }
  | { status: "failed"; failure: ReviewFailure }
  | { status: "retry"; failure: ReviewFailure }
  | { status: "empty" }
  | { status: "budget_exhausted"; usage: ReviewBudgetUsage }
  | { status: "interrupted" };

export interface ReviewDrainResult {
  completed: number;
  failed: number;
  retried: number;
  budgetExhausted: boolean;
  interrupted: boolean;
}

interface FailureClassification extends ReviewFailure {
  configurationBlock: boolean;
}

function errorCode(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 64);
  return /^[a-z]/u.test(normalized) ? normalized : "review_error";
}

function safeFailureMessage(value: string): string {
  const sanitized = sanitizeReviewText(value).slice(0, 2_000);
  return sanitized || "Review worker failed without an error message.";
}

/** Retry decisions are explicit and stable; unknown infrastructure errors retry conservatively. */
export function classifyReviewFailure(error: unknown, aborted = false): FailureClassification {
  if (aborted) {
    return { code: "aborted", message: "Review worker was interrupted.", retryable: true, configurationBlock: false };
  }
  if (error instanceof ModelRunError) {
    return {
      code: errorCode(error.code),
      message: safeFailureMessage(error.message),
      retryable: error.retryable,
      configurationBlock: error.code === "auth_unavailable"
        || error.code === "model_not_found"
        || error.code === "model_registry_invalid",
    };
  }
  if (error instanceof ReviewEngineError) {
    return {
      code: errorCode(error.code),
      message: safeFailureMessage(error.message),
      retryable: error.retryable,
      configurationBlock: false,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const permanent = /(?:invalid review job|unsupported review|protocol validation)/iu.test(message);
  return {
    code: permanent ? "invalid_job" : "worker_error",
    message: safeFailureMessage(message),
    retryable: !permanent,
    configurationBlock: false,
  };
}

function provenanceFrom(error: unknown): ReviewModelProvenance | undefined {
  if (error instanceof ModelRunError || error instanceof ReviewEngineError) return error.provenance;
  return undefined;
}

export function defaultReviewWorkerId(): string {
  const host = hostname().replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 80) || "localhost";
  return `${host}:${process.pid}`;
}

function positiveMs(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${label}.`);
  return value;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Serial spool worker. It can optionally admit completed proposals through a fenced committer. */
export class ReviewDaemon {
  private readonly spool: ReviewSpoolAdapter;
  private readonly engine: ReviewEngine;
  private readonly budget: ReviewDailyBudgetLimits;
  private readonly budgetAccount: ReviewBudgetAccount;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly maxAttempts: number;
  private readonly emit: (event: ReviewDaemonEvent) => void;
  private readonly committer?: ProposalCommitter;
  private readonly maintenance?: () => Promise<void>;
  private readonly maintenanceIntervalMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly shutdownController = new AbortController();
  private running = false;

  constructor(options: ReviewDaemonOptions) {
    this.spool = options.spool;
    this.engine = options.engine;
    this.budget = checkedLimits(options.budget);
    this.budgetAccount = options.budgetAccount ?? new InMemoryReviewBudgetAccount();
    this.workerId = options.workerId ?? defaultReviewWorkerId();
    this.leaseMs = positiveMs(options.leaseMs ?? DEFAULT_REVIEW_LEASE_MS, "review lease duration");
    this.pollMs = positiveMs(options.pollMs ?? DEFAULT_REVIEW_POLL_MS, "review poll interval");
    this.maxAttempts = positiveMs(options.maxAttempts ?? DEFAULT_REVIEW_MAX_ATTEMPTS, "review attempt limit");
    this.emit = options.onEvent ?? (() => undefined);
    this.committer = options.committer;
    this.maintenance = options.maintenance;
    this.maintenanceIntervalMs = positiveMs(options.maintenanceIntervalMs ?? 60 * 60_000, "review maintenance interval");
    this.sleep = options.sleep ?? defaultSleep;
  }

  stop(): void {
    this.shutdownController.abort();
  }

  async processOne(signal?: AbortSignal): Promise<ReviewWorkResult> {
    const workSignal = signal
      ? AbortSignal.any([signal, this.shutdownController.signal])
      : this.shutdownController.signal;
    if (workSignal.aborted) return { status: "interrupted" };

    const usage = await this.budgetAccount.snapshot();
    if (!mayStart(usage, this.budget)) {
      this.emit({ type: "budget_exhausted", usage });
      return { status: "budget_exhausted", usage };
    }

    const reserved = await this.budgetAccount.reserveCall(this.budget);
    if (!reserved) {
      const current = await this.budgetAccount.snapshot();
      this.emit({ type: "budget_exhausted", usage: current });
      return { status: "budget_exhausted", usage: current };
    }
    const claim = await this.spool.claim({ workerId: this.workerId, leaseMs: this.leaseMs });
    if (!claim) {
      await this.budgetAccount.releaseCall();
      return { status: "empty" };
    }
    this.emit({ type: "claimed", jobId: claim.job.id, attempt: claim.attempt });

    // Configuration failures may outlive the normal attempt ceiling without
    // consuming a provider call. The catch path applies maxAttempts only after
    // classifying the current failure.
    const leaseController = new AbortController();
    const reviewSignal = AbortSignal.any([workSignal, leaseController.signal]);
    let renewing = false;
    let renewalError: unknown;
    const interval = setInterval(async () => {
      if (renewing || reviewSignal.aborted) return;
      renewing = true;
      try {
        await this.spool.renew(claim, this.leaseMs);
      } catch (error) {
        renewalError = error;
        leaseController.abort();
      } finally {
        renewing = false;
      }
    }, Math.max(1, Math.floor(this.leaseMs / 3)));
    interval.unref?.();

    let usageCharged = false;
    try {
      const proposal = await this.engine.review(claim.job, reviewSignal);
      await this.budgetAccount.charge(proposal.provenance);
      usageCharged = true;
      const outcome = createReviewOutcome(claim.job, {
        status: "completed",
        completedAt: proposal.provenance.completedAt,
        operations: proposal.plan.operations,
        provenance: proposal.provenance,
      });
      const admission = this.committer ? await this.committer.commit(claim.job, outcome) : undefined;
      await this.spool.finish(claim, outcome);
      clearInterval(interval);
      this.emit({
        type: "completed",
        jobId: claim.job.id,
        attempt: claim.attempt,
        provenance: proposal.provenance,
        ...(admission ? { admission } : {}),
      });
      return { status: "completed", proposal, ...(admission ? { admission } : {}) };
    } catch (error) {
      clearInterval(interval);
      const provenance = provenanceFrom(error);
      if (provenance && !usageCharged) await this.budgetAccount.charge(provenance);
      const interrupted = workSignal.aborted;
      if (interrupted) return { status: "interrupted" };
      const actualError = renewalError ?? error;
      const classified = classifyReviewFailure(actualError, false);
      if (classified.configurationBlock && !provenance) await this.budgetAccount.releaseCall();
      const shouldRetry = classified.retryable && (classified.configurationBlock || claim.attempt < this.maxAttempts);
      const failure: ReviewFailure = {
        code: classified.code,
        message: classified.message,
        retryable: shouldRetry,
      };
      if (shouldRetry) {
        this.emit({ type: "retry", jobId: claim.job.id, attempt: claim.attempt, failure });
        // No acknowledgement: fenced lease expiry makes the durable spool requeue it.
        return { status: "retry", failure };
      }
      await this.spool.finish(claim, createReviewOutcome(claim.job, {
        status: "failed",
        error: { ...failure, retryable: false },
        ...(provenance ? { provenance } : {}),
      }));
      const terminal = { ...failure, retryable: false };
      this.emit({ type: "failed", jobId: claim.job.id, attempt: claim.attempt, failure: terminal });
      return { status: "failed", failure: terminal };
    }
  }

  async drain(signal?: AbortSignal): Promise<ReviewDrainResult> {
    const result: ReviewDrainResult = {
      completed: 0,
      failed: 0,
      retried: 0,
      budgetExhausted: false,
      interrupted: false,
    };
    for (;;) {
      const work = await this.processOne(signal);
      if (work.status === "completed") result.completed += 1;
      else if (work.status === "failed") result.failed += 1;
      else if (work.status === "retry") result.retried += 1;
      else if (work.status === "budget_exhausted") result.budgetExhausted = true;
      else if (work.status === "interrupted") result.interrupted = true;
      if (work.status === "empty" || work.status === "budget_exhausted" || work.status === "interrupted") return result;
    }
  }

  async run(signal?: AbortSignal): Promise<void> {
    if (this.running) throw new Error("Review daemon is already running.");
    this.running = true;
    const runSignal = signal
      ? AbortSignal.any([signal, this.shutdownController.signal])
      : this.shutdownController.signal;
    try {
      await this.spool.initialize();
      await this.spool.recover();
      let nextMaintenanceAt = 0;
      while (!runSignal.aborted) {
        if (this.maintenance && Date.now() >= nextMaintenanceAt) {
          await this.maintenance();
          nextMaintenanceAt = Date.now() + this.maintenanceIntervalMs;
        }
        const drained = await this.drain(runSignal);
        if (drained.interrupted) break;
        this.emit({ type: "idle" });
        await this.sleep(this.pollMs, runSignal);
      }
    } finally {
      this.running = false;
    }
  }
}
