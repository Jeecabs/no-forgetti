import { hostname } from "node:os";
import { readFile } from "node:fs/promises";

import { atomicWriteFile } from "../atomic-file.ts";
import { withFileLock } from "../file-lock.ts";
import { ModelRunError, type ModelDispatchContext, type ModelRunHooks, type ReviewModelProvenance } from "./model-runner.ts";
import type { AdmissionReceipt, ProposalCommitter } from "./admission.ts";
import {
  reviewAttemptId,
  usdToNanodollars,
  type ReviewAttemptAccounting,
  type ReviewAttemptReservation,
  type ReviewBudgetSnapshot,
} from "./accounting.ts";
import {
  ReviewDecisionStore,
  type ReviewAttemptDecision,
  type ReviewProposalDecision,
} from "./decisions.ts";
import type { LedgerProviderAttempt, ReviewLedger } from "./ledger.ts";
import { createReviewOutcome, sanitizeReviewText, type ReviewFailure, type ReviewJob } from "./protocol.ts";
import { ReviewEngine, ReviewEngineError, type ReviewProposal } from "./review-engine.ts";
import { ReviewLeaseError, type ReviewClaim, type ReviewSpool } from "./spool.ts";

export const DEFAULT_REVIEW_LEASE_MS = 5 * 60_000;
export const DEFAULT_REVIEW_POLL_MS = 5_000;
export const DEFAULT_REVIEW_MAX_ATTEMPTS = 3;
export const DEFAULT_REVIEW_RETRY_BASE_MS = 5_000;
export const DEFAULT_REVIEW_CONFIG_RETRY_BASE_MS = 60_000;
export const DEFAULT_REVIEW_RETRY_MAX_MS = 60 * 60_000;

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
  | { type: "attempt_budget_exhausted"; jobId: string; attempt: number; provider: string; usage: ReviewBudgetSnapshot }
  | { type: "idle" };

export interface ReviewSpoolAdapter {
  initialize(): Promise<void>;
  recover(): Promise<unknown>;
  claim(options: { workerId: string; leaseMs: number }): Promise<ReviewClaim | undefined>;
  renew(claim: ReviewClaim, leaseMs: number): Promise<ReviewClaim>;
  finish(claim: ReviewClaim, outcome: ReturnType<typeof createReviewOutcome>): Promise<unknown>;
  defer?(claim: ReviewClaim, options?: { delayMs?: number }): Promise<unknown>;
}

export interface ReviewDaemonOptions {
  spool: ReviewSpoolAdapter | ReviewSpool;
  engine: ReviewEngine;
  budget: ReviewDailyBudgetLimits;
  budgetAccount?: ReviewBudgetAccount;
  /** Durable per-provider reservation/dispatch/settlement authority. Requires decisionStore. */
  attemptAccounting?: ReviewAttemptAccounting;
  /** Durable provider-result checkpoint and one-winner proposal election. Requires attemptAccounting. */
  decisionStore?: ReviewDecisionStore;
  /** Best-effort SQLite observer. Filesystem records remain authoritative. */
  ledger?: ReviewLedger;
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
  | { status: "attempt_budget_exhausted"; provider: string; usage: ReviewBudgetSnapshot }
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
      configurationBlock: error.code === "incompatible_policy",
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

function retryDelayMs(attempt: number, configurationBlock: boolean): number {
  const base = configurationBlock ? DEFAULT_REVIEW_CONFIG_RETRY_BASE_MS : DEFAULT_REVIEW_RETRY_BASE_MS;
  return Math.min(DEFAULT_REVIEW_RETRY_MAX_MS, base * (2 ** Math.min(16, Math.max(0, attempt - 1))));
}

function untilNextUtcDayMs(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1_000, next - now.getTime());
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

interface DurableAttemptState {
  claim?: ReviewClaim;
  reservation?: ReviewAttemptReservation;
  dispatch?: ModelDispatchContext;
  dispatchCheckpointStarted: boolean;
  settled: boolean;
  observedProvenance?: ReviewModelProvenance;
}

class AttemptBudgetExhaustedError extends Error {
  readonly provider: string;
  readonly usage: ReviewBudgetSnapshot;

  constructor(provider: string, usage: ReviewBudgetSnapshot) {
    super(`Daily review attempt budget exhausted for provider '${provider}'.`);
    this.name = "AttemptBudgetExhaustedError";
    this.provider = provider;
    this.usage = usage;
  }
}

/** Keeps durable attempt accounting and proposal election behind one narrow seam. */
class DurableAttemptCoordinator {
  private readonly accounting: ReviewAttemptAccounting;
  private readonly decisions: ReviewDecisionStore;
  private readonly limits: { maxCalls: number; maxTokens: number; maxCostNanodollars: number };
  private readonly ledger?: ReviewLedger;

  constructor(
    accounting: ReviewAttemptAccounting,
    decisions: ReviewDecisionStore,
    budget: ReviewDailyBudgetLimits,
    ledger?: ReviewLedger,
  ) {
    this.accounting = accounting;
    this.decisions = decisions;
    this.ledger = ledger;
    this.limits = {
      maxCalls: budget.maxCalls,
      maxTokens: budget.maxTokens,
      maxCostNanodollars: Math.max(1, usdToNanodollars(budget.maxCostUsd)),
    };
  }

  async loadDecision(claim: ReviewClaim): Promise<ReviewProposalDecision | undefined> {
    const decision = await this.decisions.loadDecision(claim.job.id);
    if (!decision) return undefined;
    // Provider-result authority can survive a crash immediately before usage
    // settlement. Reconcile it before publishing or shadowing the election.
    // Reservation occurs after startedAt and before completedAt, so a provider
    // call crossing UTC midnight can belong to either durable accounting day.
    const provenance = decision.outcome.provenance;
    let missingReservation: unknown;
    for (const day of new Set([provenance.startedAt.slice(0, 10), provenance.completedAt.slice(0, 10)])) {
      try {
        await this.accounting.settle({
          version: 1,
          id: decision.attemptId,
          day,
          provider: provenance.provider,
        }, provenance);
        missingReservation = undefined;
        break;
      } catch (error) {
        if (!(error instanceof Error && error.message === "Unknown review accounting reservation.")) throw error;
        missingReservation = error;
      }
    }
    if (missingReservation) throw missingReservation;
    this.shadowDecision(decision);
    return decision;
  }

  hooks(claim: ReviewClaim, state: DurableAttemptState): ModelRunHooks {
    return {
      beforeDispatch: async (context) => this.beforeDispatch(claim, context, state),
      // Observation is deliberately non-durable staging. Provider-result
      // authority must be recorded before accounting becomes settled.
      observe: async (provenance) => {
        state.observedProvenance = provenance;
        if (!state.reservation) throw new Error("Review provider response arrived without an attempt reservation.");
      },
    };
  }

  async reconcile(
    state: DurableAttemptState,
    provenance?: ReviewModelProvenance,
    failure?: ReviewFailure,
  ): Promise<void> {
    const reservation = state.reservation;
    if (!reservation || state.settled) return;
    const known = provenance ?? state.observedProvenance;
    if (known && state.dispatchCheckpointStarted) {
      await this.accounting.settle(reservation, known);
      state.settled = true;
      this.shadowAttempt(undefined, state, "settled", known, failure);
      return;
    }
    if (state.dispatchCheckpointStarted) {
      try {
        await this.accounting.markUnknown(reservation);
        this.shadowAttempt(undefined, state, "unknown");
      } catch (error) {
        // A hook failure before the dispatch checkpoint was published proves
        // provider execution did not begin, so only that reserved state may cancel.
        await this.accounting.cancelPreDispatch(reservation).catch(() => { throw error; });
        this.shadowAttempt(undefined, state, "canceled");
      }
      return;
    }
    await this.accounting.cancelPreDispatch(reservation);
    this.shadowAttempt(undefined, state, "canceled");
  }

  async recordCompleted(claim: ReviewClaim, state: DurableAttemptState, proposal: ReviewProposal): Promise<ReviewAttemptDecision> {
    const checkpoint = await this.decisions.recordAttempt(this.attemptId(claim, state), claim.job, {
      status: "completed",
      completedAt: proposal.provenance.completedAt,
      operations: proposal.plan.operations,
      provenance: proposal.provenance,
    });
    return checkpoint;
  }

  async recordFailed(
    claim: ReviewClaim,
    state: DurableAttemptState,
    failure: ReviewFailure,
    provenance?: ReviewModelProvenance,
  ): Promise<ReviewAttemptDecision> {
    const checkpoint = await this.decisions.recordAttempt(this.attemptId(claim, state), claim.job, {
      status: "failed",
      completedAt: provenance?.completedAt ?? new Date().toISOString(),
      error: failure,
      ...(provenance ? { provenance } : {}),
    });
    return checkpoint;
  }

  shadowSelected(decision: ReviewProposalDecision): void {
    this.shadowDecision(decision);
  }

  private attemptId(claim: ReviewClaim, state: DurableAttemptState): string {
    return state.reservation?.id ?? reviewAttemptId({
      jobDigest: claim.job.digest,
      attempt: claim.attempt,
      leaseToken: claim.leaseToken,
    });
  }

  private shadowAttempt(
    claimValue: ReviewClaim | undefined,
    state: DurableAttemptState,
    attemptState: LedgerProviderAttempt["state"],
    provenance?: ReviewModelProvenance,
    failure?: ReviewFailure,
  ): void {
    const claim = claimValue ?? state.claim;
    const reservation = state.reservation;
    const dispatch = state.dispatch;
    if (!this.ledger?.recordProviderAttempt || !claim || !reservation || !dispatch) return;
    const attempt: LedgerProviderAttempt = {
      providerAttemptId: reservation.id,
      jobId: claim.job.id,
      jobDigest: claim.job.digest,
      claimAttempt: claim.attempt,
      leaseToken: claim.leaseToken,
      provider: reservation.provider,
      budgetDay: reservation.day,
      state: attemptState,
      holdTokens: dispatch.hold.tokens,
      holdCostNanodollars: usdToNanodollars(dispatch.hold.costUsd),
      ...((attemptState === "dispatched" || attemptState === "settled" || attemptState === "unknown")
        ? { requestDigest: dispatch.requestDigest }
        : {}),
      ...(provenance ? {
        usageTokens: provenance.usage.totalTokens,
        usageCostNanodollars: usdToNanodollars(provenance.usage.cost.total),
        provenance,
      } : {}),
      ...(failure ? { failure } : {}),
    };
    try {
      this.ledger.recordProviderAttempt(attempt);
    } catch {
      // SQLite is a replayable observational shadow, never accounting authority.
    }
  }

  private shadowDecision(decision: ReviewProposalDecision): void {
    if (!this.ledger?.recordSelectedDecision) return;
    try {
      this.ledger.recordSelectedDecision({
        jobId: decision.job.id,
        jobDigest: decision.job.digest,
        providerAttemptId: decision.attemptId,
        proposalDigest: decision.proposalDigest,
      });
    } catch {
      // SQLite is a replayable observational shadow, never decision authority.
    }
  }

  private async beforeDispatch(
    claim: ReviewClaim,
    context: ModelDispatchContext,
    state: DurableAttemptState,
  ): Promise<void> {
    if (state.reservation) throw new Error("Review attempt tried to dispatch more than once.");
    const reservation = await this.accounting.reserve({
      claim: {
        jobId: claim.job.id,
        jobDigest: claim.job.digest,
        attempt: claim.attempt,
        leaseToken: claim.leaseToken,
      },
      provider: context.provider,
      limits: this.limits,
      hold: { tokens: context.hold.tokens, costNanodollars: usdToNanodollars(context.hold.costUsd) },
    });
    if (!reservation) {
      throw new AttemptBudgetExhaustedError(context.provider, await this.accounting.snapshot(context.provider));
    }
    state.claim = claim;
    state.reservation = reservation;
    state.dispatch = context;
    this.shadowAttempt(claim, state, "reserved");
    state.dispatchCheckpointStarted = true;
    await this.accounting.commitDispatch(reservation, {
      requestDigest: context.requestDigest,
      model: context.model,
      api: context.api,
    });
    this.shadowAttempt(claim, state, "dispatched");
  }
}

function proposalFromDecision(decision: ReviewProposalDecision): ReviewProposal {
  return {
    jobId: decision.job.id,
    jobDigest: decision.job.digest,
    throughEntryId: decision.job.throughEntryId,
    plan: { operations: decision.outcome.operations },
    provenance: decision.outcome.provenance,
  };
}

/** Serial spool worker. It can optionally admit completed proposals through a fenced committer. */
export class ReviewDaemon {
  private readonly spool: ReviewSpoolAdapter;
  private readonly engine: ReviewEngine;
  private readonly budget: ReviewDailyBudgetLimits;
  private readonly budgetAccount: ReviewBudgetAccount;
  private readonly durableAttempts?: DurableAttemptCoordinator;
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
    if (Boolean(options.attemptAccounting) !== Boolean(options.decisionStore)) {
      throw new Error("Review attemptAccounting and decisionStore must be configured together.");
    }
    this.durableAttempts = options.attemptAccounting && options.decisionStore
      ? new DurableAttemptCoordinator(options.attemptAccounting, options.decisionStore, this.budget, options.ledger)
      : undefined;
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
    if (this.durableAttempts) return this.processDurableOne(workSignal, this.durableAttempts);
    return this.processLegacyOne(workSignal);
  }

  private async processLegacyOne(workSignal: AbortSignal): Promise<ReviewWorkResult> {
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
      // Absent provenance the provider never reported usage for this attempt, so
      // the reserved call must return to the daily budget instead of leaking.
      if (!provenance) await this.budgetAccount.releaseCall();
      const shouldRetry = classified.retryable && (classified.configurationBlock || claim.attempt < this.maxAttempts);
      const failure: ReviewFailure = {
        code: classified.code,
        message: classified.message,
        retryable: shouldRetry,
      };
      if (shouldRetry) {
        this.emit({ type: "retry", jobId: claim.job.id, attempt: claim.attempt, failure });
        // Prefer immediate fenced requeue when adapter supports it; older
        // adapters preserve lease-expiry retry behavior.
        await this.deferClaim(claim, retryDelayMs(claim.attempt, classified.configurationBlock));
        return { status: "retry", failure };
      }
      const terminal = { ...failure, retryable: false };
      await this.spool.finish(claim, createReviewOutcome(claim.job, {
        status: "failed",
        error: terminal,
        ...(provenance ? { provenance } : {}),
      }));
      await this.publishTerminalFailure(claim.job, terminal);
      this.emit({ type: "failed", jobId: claim.job.id, attempt: claim.attempt, failure: terminal });
      return { status: "failed", failure: terminal };
    }
  }

  /**
   * Best-effort dead-letter notification. It must only run after the durable
   * terminal transition: publishing "failed" before `spool.finish` resolves
   * could collide with an "applied" publication from a lease-fenced retry
   * that later completes the job. Mailbox GC reclaims lost notifications.
   */
  private async publishTerminalFailure(job: ReviewJob, failure: ReviewFailure): Promise<void> {
    try {
      await this.committer?.failed?.(job, failure);
    } catch {
      // Swallowed: the job outcome is already durable and delivery is optional.
    }
  }

  private async processDurableOne(
    workSignal: AbortSignal,
    coordinator: DurableAttemptCoordinator,
  ): Promise<ReviewWorkResult> {
    const claim = await this.spool.claim({ workerId: this.workerId, leaseMs: this.leaseMs });
    if (!claim) return { status: "empty" };
    this.emit({ type: "claimed", jobId: claim.job.id, attempt: claim.attempt });

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

    try {
      const selected = await coordinator.loadDecision(claim);
      if (selected) return this.finishSelectedOrRetry(claim, selected, workSignal, () => renewalError);

      const state: DurableAttemptState = {
        dispatchCheckpointStarted: false,
        settled: false,
      };
      let proposal: ReviewProposal;
      try {
        proposal = await this.engine.review(claim.job, reviewSignal, coordinator.hooks(claim, state));
        if (!state.reservation || !state.dispatchCheckpointStarted || !state.observedProvenance) {
          throw new ReviewEngineError(
            "invalid_proposal",
            "Review model runner bypassed durable attempt checkpoints.",
            { retryable: true, provenance: proposal.provenance },
          );
        }
      } catch (error) {
        if (error instanceof AttemptBudgetExhaustedError) {
          this.emit({
            type: "attempt_budget_exhausted",
            jobId: claim.job.id,
            attempt: claim.attempt,
            provider: error.provider,
            usage: error.usage,
          });
          await this.deferClaim(claim, untilNextUtcDayMs());
          return { status: "attempt_budget_exhausted", provider: error.provider, usage: error.usage };
        }

        const provenance = provenanceFrom(error) ?? state.observedProvenance;
        const interrupted = workSignal.aborted;
        const classified = classifyReviewFailure(renewalError ?? error, interrupted);
        const shouldRetry = classified.retryable
          && (classified.configurationBlock || claim.attempt < this.maxAttempts);
        const failure: ReviewFailure = {
          code: classified.code,
          message: classified.message,
          retryable: shouldRetry,
        };
        // Failed provider result is crash authority. Publish it before turning
        // its reservation into settled usage.
        const checkpoint = await coordinator.recordFailed(claim, state, failure, provenance);
        await coordinator.reconcile(state, provenance, provenance ? failure : undefined);
        if (checkpoint.decision) {
          coordinator.shadowSelected(checkpoint.decision);
          return this.finishSelectedOrRetry(claim, checkpoint.decision, workSignal, () => renewalError);
        }
        if (interrupted) return { status: "interrupted" };
        if (shouldRetry) {
          this.emit({ type: "retry", jobId: claim.job.id, attempt: claim.attempt, failure });
          await this.deferClaim(claim, retryDelayMs(claim.attempt, classified.configurationBlock));
          return { status: "retry", failure };
        }
        const terminal = { ...failure, retryable: false };
        await this.spool.finish(claim, createReviewOutcome(claim.job, {
          status: "failed",
          error: terminal,
          ...(provenance ? { provenance } : {}),
        }));
        await this.publishTerminalFailure(claim.job, terminal);
        this.emit({ type: "failed", jobId: claim.job.id, attempt: claim.attempt, failure: terminal });
        return { status: "failed", failure: terminal };
      }

      // Elect and durably publish provider result before settling its usage.
      const checkpoint = await coordinator.recordCompleted(claim, state, proposal);
      if (!checkpoint.decision) throw new Error("Completed review attempt did not produce a proposal decision.");
      await coordinator.reconcile(state, proposal.provenance);
      coordinator.shadowSelected(checkpoint.decision);
      return this.finishSelectedOrRetry(claim, checkpoint.decision, workSignal, () => renewalError);
    } finally {
      clearInterval(interval);
    }
  }

  private async finishSelectedOrRetry(
    claim: ReviewClaim,
    decision: ReviewProposalDecision,
    workSignal: AbortSignal,
    renewalError: () => unknown,
  ): Promise<ReviewWorkResult> {
    try {
      const proposal = proposalFromDecision(decision);
      const admission = this.committer ? await this.committer.commit(decision.job, decision.outcome) : undefined;
      await this.spool.finish(claim, decision.outcome);
      this.emit({
        type: "completed",
        jobId: claim.job.id,
        attempt: claim.attempt,
        provenance: proposal.provenance,
        ...(admission ? { admission } : {}),
      });
      return { status: "completed", proposal, ...(admission ? { admission } : {}) };
    } catch (error) {
      if (workSignal.aborted) return { status: "interrupted" };
      const classified = classifyReviewFailure(renewalError() ?? error);
      // Elected result remains authoritative: publication retries that result
      // rather than electing or dispatching another provider attempt. The
      // attempt ceiling still applies, so a deterministically failing committer
      // dead-letters instead of re-deferring forever.
      const shouldRetry = claim.attempt < this.maxAttempts;
      const failure: ReviewFailure = {
        code: classified.code,
        message: classified.message,
        retryable: shouldRetry,
      };
      if (shouldRetry) {
        this.emit({ type: "retry", jobId: claim.job.id, attempt: claim.attempt, failure });
        await this.deferClaim(claim, DEFAULT_REVIEW_RETRY_BASE_MS);
        return { status: "retry", failure };
      }
      const terminal = { ...failure, retryable: false };
      await this.spool.finish(claim, createReviewOutcome(claim.job, {
        status: "failed",
        error: terminal,
        provenance: decision.outcome.provenance,
      }));
      await this.publishTerminalFailure(decision.job, terminal);
      this.emit({ type: "failed", jobId: claim.job.id, attempt: claim.attempt, failure: terminal });
      return { status: "failed", failure: terminal };
    }
  }

  private async deferClaim(claim: ReviewClaim, delayMs = 0): Promise<void> {
    if (!this.spool.defer) return;
    try {
      await this.spool.defer(claim, delayMs > 0 ? { delayMs } : undefined);
    } catch (error) {
      // A newer lease or durable terminal outcome already fences this worker.
      // Normal recovery/cleanup owns the remaining queue transition.
      if (!(error instanceof ReviewLeaseError)) throw error;
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
      else if (work.status === "budget_exhausted" || work.status === "attempt_budget_exhausted") result.budgetExhausted = true;
      else if (work.status === "interrupted") result.interrupted = true;
      if (work.status === "empty" || work.status === "retry" || work.status === "budget_exhausted"
        || work.status === "attempt_budget_exhausted" || work.status === "interrupted") return result;
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
