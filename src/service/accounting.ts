import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { atomicCreateFile, atomicWriteFile, durableUnlink } from "../atomic-file.ts";
import { withFileLock } from "../file-lock.ts";
import { exactKeys, isErrno, isRecord } from "../state-validation.ts";
import type { ReviewModelProvenance } from "./protocol.ts";

export const REVIEW_ACCOUNTING_VERSION = 1 as const;
export const MAX_REVIEW_ACCOUNTING_DAY_BYTES = 16 * 1024 * 1024;
export const MAX_REVIEW_ACCOUNTING_RETENTION_ENTRIES = 20_000;
export const MAX_REVIEW_ACCOUNTING_RECOVERY_BATCH = 1_000;
export const MAX_REVIEW_ACCOUNTING_IDENTITY_BYTES = 4_096;

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_TEMPORARY = /^(\d{4}-\d{2}-\d{2})\.\d+\.[0-9a-f-]{36}\.tmp$/u;
const IDENTITY_TEMPORARY = /^review_attempt_[0-9a-f]{40}\.\d+\.[0-9a-f-]{36}\.tmp$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const LEASE_TOKEN = /^[0-9a-f]{32}$/u;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ATTEMPT_ID = /^review_attempt_[0-9a-f]{40}$/u;
const JOB_ID = /^review_[0-9a-f]{40}$/u;

export interface ReviewAttemptClaim {
  jobId?: string;
  jobDigest: string;
  attempt: number;
  leaseToken: string;
}

export interface ReviewDailyBudgetLimits {
  maxCalls: number;
  maxTokens: number;
  maxCostNanodollars: number;
}

export interface ReviewAttemptHold {
  tokens: number;
  costNanodollars: number;
}

export interface ReviewAttemptReservation {
  version: typeof REVIEW_ACCOUNTING_VERSION;
  id: string;
  day: string;
  provider: string;
}

export interface ReviewBudgetAmount {
  calls: number;
  tokens: number;
  costNanodollars: number;
}

export interface ReviewBudgetSnapshot {
  version: typeof REVIEW_ACCOUNTING_VERSION;
  day: string;
  provider: string;
  charged: ReviewBudgetAmount;
  held: ReviewBudgetAmount;
  unknown: ReviewBudgetAmount;
  effective: ReviewBudgetAmount;
}

export interface ReviewAttemptReservationRequest {
  claim: ReviewAttemptClaim;
  provider: string;
  limits: ReviewDailyBudgetLimits;
  hold: ReviewAttemptHold;
}

export interface ReviewAttemptDispatch {
  requestDigest: string;
  model: string;
  api: string;
}

export interface ReviewAttemptRecoveryCandidate {
  reservation: ReviewAttemptReservation;
  claim: ReviewAttemptClaim;
  state: "reserved" | "dispatched";
  reservedAt: string;
  dispatchedAt?: string;
  dispatch?: ReviewAttemptDispatch;
}

export interface ReviewAttemptRecoveryPage {
  candidates: ReviewAttemptRecoveryCandidate[];
  /** Pass to the next call. Undefined means the immutable identity index is exhausted. */
  nextCursor?: string;
}

export interface ReviewAttemptRecoveryResult {
  reservation: ReviewAttemptReservation;
  provenance: ReviewModelProvenance;
  /** Required for new result checkpoints; optional only for conservative legacy recovery. */
  dispatch?: ReviewAttemptDispatch;
}

export interface ReviewAttemptRecoveryRequest {
  candidates: readonly ReviewAttemptReservation[];
  liveLeaseTokens: readonly string[];
  results: readonly ReviewAttemptRecoveryResult[];
  expiresBefore: string;
}

export interface ReviewAttemptRecoveryReport {
  settled: string[];
  canceled: string[];
  unknown: string[];
  unchanged: string[];
}

export interface LegacyReviewDailyBudget {
  version: 1;
  day: string;
  calls: number;
  tokens: number;
  costUsd: number;
}

export interface ReviewAttemptAccounting {
  initialize(): Promise<void>;
  reserve(request: ReviewAttemptReservationRequest): Promise<ReviewAttemptReservation | undefined>;
  commitDispatch(reservation: ReviewAttemptReservation, dispatch?: ReviewAttemptDispatch): Promise<void>;
  settle(reservation: ReviewAttemptReservation, provenance: ReviewModelProvenance): Promise<void>;
  markUnknown(reservation: ReviewAttemptReservation): Promise<void>;
  cancelPreDispatch(reservation: ReviewAttemptReservation): Promise<void>;
  snapshot(provider: string, day?: string): Promise<ReviewBudgetSnapshot>;
  importLegacyDailyBudget?(provider: string, legacy: LegacyReviewDailyBudget): Promise<boolean>;
  listRecoveryCandidates?(options: { limit: number; cursor?: string }): Promise<ReviewAttemptRecoveryPage>;
  reconcileRecovery?(request: ReviewAttemptRecoveryRequest): Promise<ReviewAttemptRecoveryReport>;
}

type AttemptState = "reserved" | "dispatched" | "settled" | "unknown" | "canceled";

interface StoredAttempt {
  id: string;
  jobId?: string;
  jobDigest: string;
  claimAttempt: number;
  leaseToken: string;
  provider: string;
  state: AttemptState;
  reservedAt: string;
  holdTokens: number;
  holdCostNanodollars: number;
  dispatchedAt?: string;
  requestDigest?: string;
  model?: string;
  api?: string;
  settledAt?: string;
  chargedTokens?: number;
  chargedCostNanodollars?: number;
  provenance?: ReviewModelProvenance;
  unknownAt?: string;
  canceledAt?: string;
}

interface StoredLegacyCarry {
  sourceDigest: string;
  importedAt: string;
  calls: number;
  tokens: number;
  costNanodollars: number;
}

interface StoredDay {
  version: typeof REVIEW_ACCOUNTING_VERSION;
  day: string;
  providers: Record<string, StoredAttempt[]>;
  legacyCarry?: Record<string, StoredLegacyCarry>;
}

interface StoredIdentity {
  version: typeof REVIEW_ACCOUNTING_VERSION;
  id: string;
  day: string;
  provider: string;
  jobId?: string;
  jobDigest: string;
  claimAttempt: number;
  leaseToken: string;
  reservedAt: string;
  holdTokens: number;
  holdCostNanodollars: number;
}

export interface FileReviewAttemptAccountingOptions {
  now?: () => Date;
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}.`);
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonnegativeInteger(value, label);
  if (parsed < 1) throw new Error(`Invalid ${label}.`);
  return parsed;
}

function checkedIso(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`Invalid ${label}.`);
  return value;
}

function checkedProvider(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER.test(value)) throw new Error("Invalid review accounting provider.");
  return value;
}

function checkedDispatchString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 256) throw new Error(`Invalid review accounting ${label}.`);
  return value;
}

function checkedDispatch(value: ReviewAttemptDispatch): ReviewAttemptDispatch {
  if (!isRecord(value) || typeof value.requestDigest !== "string" || !DIGEST.test(value.requestDigest)) {
    throw new Error("Invalid review accounting dispatch.");
  }
  exactKeys(value, ["requestDigest", "model", "api"]);
  return {
    requestDigest: value.requestDigest,
    model: checkedDispatchString(value.model, "dispatch model"),
    api: checkedDispatchString(value.api, "dispatch API"),
  };
}

function checkedDay(value: unknown): string {
  if (typeof value !== "string" || !DAY.test(value)) throw new Error("Invalid review accounting UTC day.");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("Invalid review accounting UTC day.");
  }
  return value;
}

function checkedClock(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Invalid review accounting clock.");
  return value;
}

function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseCost(value: unknown): ReviewModelProvenance["usage"]["cost"] {
  if (!isRecord(value)) throw new Error("Invalid review accounting provenance cost.");
  exactKeys(value, ["input", "output", "cacheRead", "cacheWrite", "total"]);
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) {
      throw new Error("Invalid review accounting provenance cost.");
    }
  }
  return {
    input: value.input as number,
    output: value.output as number,
    cacheRead: value.cacheRead as number,
    cacheWrite: value.cacheWrite as number,
    total: value.total as number,
  };
}

function parseProvenance(value: unknown): ReviewModelProvenance {
  if (!isRecord(value)) throw new Error("Invalid review accounting provenance.");
  exactKeys(value, ["provider", "model", "api", "startedAt", "completedAt", "durationMs", "usage"], ["responseModel", "responseId"]);
  const provider = checkedProvider(value.provider);
  for (const key of ["model", "api"] as const) {
    if (typeof value[key] !== "string" || !value[key] || value[key].length > 256) throw new Error("Invalid review accounting provenance.");
  }
  if (value.responseModel !== undefined && (typeof value.responseModel !== "string" || !value.responseModel || value.responseModel.length > 256)) {
    throw new Error("Invalid review accounting provenance.");
  }
  if (value.responseId !== undefined && (typeof value.responseId !== "string" || !value.responseId || value.responseId.length > 512)) {
    throw new Error("Invalid review accounting provenance.");
  }
  if (!isRecord(value.usage)) throw new Error("Invalid review accounting provenance usage.");
  exactKeys(value.usage, ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"], ["reasoning"]);
  const usage: ReviewModelProvenance["usage"] = {
    input: nonnegativeInteger(value.usage.input, "review accounting input usage"),
    output: nonnegativeInteger(value.usage.output, "review accounting output usage"),
    cacheRead: nonnegativeInteger(value.usage.cacheRead, "review accounting cache-read usage"),
    cacheWrite: nonnegativeInteger(value.usage.cacheWrite, "review accounting cache-write usage"),
    totalTokens: nonnegativeInteger(value.usage.totalTokens, "review accounting total-token usage"),
    cost: parseCost(value.usage.cost),
  };
  if (value.usage.reasoning !== undefined) usage.reasoning = nonnegativeInteger(value.usage.reasoning, "review accounting reasoning usage");
  return {
    provider,
    model: value.model as string,
    api: value.api as string,
    ...(value.responseModel === undefined ? {} : { responseModel: value.responseModel as string }),
    ...(value.responseId === undefined ? {} : { responseId: value.responseId as string }),
    startedAt: checkedIso(value.startedAt, "review accounting provenance start"),
    completedAt: checkedIso(value.completedAt, "review accounting provenance completion"),
    durationMs: nonnegativeInteger(value.durationMs, "review accounting provenance duration"),
    usage,
  };
}

function parseAttempt(value: unknown, provider: string): StoredAttempt {
  if (!isRecord(value)) throw new Error("Invalid review accounting attempt.");
  const common = ["id", "jobDigest", "claimAttempt", "leaseToken", "provider", "state", "reservedAt", "holdTokens", "holdCostNanodollars"];
  const dispatch = ["requestDigest", "model", "api"];
  const hasDispatch = dispatch.some((key) => value[key] !== undefined);
  if (hasDispatch && dispatch.some((key) => value[key] === undefined)) throw new Error("Invalid review accounting dispatch identity.");
  const optionalDispatch = hasDispatch ? dispatch : [];
  if (value.state === "reserved") exactKeys(value, common, ["jobId"]);
  else if (value.state === "dispatched") exactKeys(value, [...common, "dispatchedAt", ...optionalDispatch], ["jobId"]);
  else if (value.state === "settled") exactKeys(value, [...common, "dispatchedAt", "settledAt", "chargedTokens", "chargedCostNanodollars", "provenance", ...optionalDispatch], ["jobId"]);
  else if (value.state === "unknown") exactKeys(value, [...common, "dispatchedAt", "unknownAt", ...optionalDispatch], ["jobId"]);
  else if (value.state === "canceled") exactKeys(value, [...common, "canceledAt"], ["jobId"]);
  else throw new Error("Invalid review accounting attempt state.");
  if (typeof value.id !== "string" || !ATTEMPT_ID.test(value.id)
    || typeof value.jobDigest !== "string" || !DIGEST.test(value.jobDigest)
    || typeof value.leaseToken !== "string" || !LEASE_TOKEN.test(value.leaseToken)
    || value.provider !== provider) throw new Error("Invalid review accounting attempt identity.");
  if (value.jobId !== undefined && (typeof value.jobId !== "string" || !JOB_ID.test(value.jobId))) {
    throw new Error("Invalid review accounting job id.");
  }
  const attempt: StoredAttempt = {
    id: value.id,
    ...(value.jobId === undefined ? {} : { jobId: value.jobId as string }),
    jobDigest: value.jobDigest,
    claimAttempt: positiveInteger(value.claimAttempt, "review accounting claim attempt"),
    leaseToken: value.leaseToken,
    provider,
    state: value.state,
    reservedAt: checkedIso(value.reservedAt, "review accounting reservation timestamp"),
    holdTokens: positiveInteger(value.holdTokens, "review accounting token hold"),
    holdCostNanodollars: nonnegativeInteger(value.holdCostNanodollars, "review accounting cost hold"),
  };
  if (value.dispatchedAt !== undefined) attempt.dispatchedAt = checkedIso(value.dispatchedAt, "review accounting dispatch timestamp");
  if (hasDispatch) {
    const parsedDispatch = checkedDispatch({ requestDigest: value.requestDigest, model: value.model, api: value.api } as ReviewAttemptDispatch);
    attempt.requestDigest = parsedDispatch.requestDigest;
    attempt.model = parsedDispatch.model;
    attempt.api = parsedDispatch.api;
  }
  if (value.settledAt !== undefined) attempt.settledAt = checkedIso(value.settledAt, "review accounting settlement timestamp");
  if (value.chargedTokens !== undefined) attempt.chargedTokens = nonnegativeInteger(value.chargedTokens, "review accounting charged tokens");
  if (value.chargedCostNanodollars !== undefined) attempt.chargedCostNanodollars = nonnegativeInteger(value.chargedCostNanodollars, "review accounting charged cost");
  if (value.provenance !== undefined) attempt.provenance = parseProvenance(value.provenance);
  if (value.unknownAt !== undefined) attempt.unknownAt = checkedIso(value.unknownAt, "review accounting unknown timestamp");
  if (value.canceledAt !== undefined) attempt.canceledAt = checkedIso(value.canceledAt, "review accounting cancellation timestamp");
  if (reviewAttemptId({ jobDigest: attempt.jobDigest, attempt: attempt.claimAttempt, leaseToken: attempt.leaseToken }) !== attempt.id) {
    throw new Error("Invalid review accounting deterministic attempt id.");
  }
  return attempt;
}

function parseDay(value: unknown, expectedDay: string): StoredDay {
  if (!isRecord(value)) throw new Error("Invalid review accounting day record.");
  exactKeys(value, ["version", "day", "providers"], ["legacyCarry"]);
  if (value.version !== REVIEW_ACCOUNTING_VERSION || value.day !== expectedDay || !isRecord(value.providers)) {
    throw new Error("Invalid review accounting day record.");
  }
  const providers: Record<string, StoredAttempt[]> = Object.create(null) as Record<string, StoredAttempt[]>;
  const ids = new Set<string>();
  for (const [provider, attempts] of Object.entries(value.providers)) {
    checkedProvider(provider);
    if (!Array.isArray(attempts) || attempts.length > 20_000) throw new Error("Invalid review accounting provider attempts.");
    const parsed = attempts.map((attempt) => parseAttempt(attempt, provider));
    for (const attempt of parsed) {
      if (ids.has(attempt.id)) throw new Error("Duplicate review accounting attempt id.");
      ids.add(attempt.id);
    }
    providers[provider] = parsed;
  }
  let legacyCarry: Record<string, StoredLegacyCarry> | undefined;
  if (value.legacyCarry !== undefined) {
    if (!isRecord(value.legacyCarry)) throw new Error("Invalid review accounting legacy carry.");
    legacyCarry = Object.create(null) as Record<string, StoredLegacyCarry>;
    for (const [provider, raw] of Object.entries(value.legacyCarry)) {
      checkedProvider(provider);
      if (!isRecord(raw)) throw new Error("Invalid review accounting legacy carry.");
      exactKeys(raw, ["sourceDigest", "importedAt", "calls", "tokens", "costNanodollars"]);
      if (typeof raw.sourceDigest !== "string" || !DIGEST.test(raw.sourceDigest)) throw new Error("Invalid review accounting legacy carry.");
      legacyCarry[provider] = {
        sourceDigest: raw.sourceDigest,
        importedAt: checkedIso(raw.importedAt, "review accounting legacy import timestamp"),
        calls: nonnegativeInteger(raw.calls, "review accounting legacy calls"),
        tokens: nonnegativeInteger(raw.tokens, "review accounting legacy tokens"),
        costNanodollars: nonnegativeInteger(raw.costNanodollars, "review accounting legacy cost"),
      };
    }
  }
  return { version: REVIEW_ACCOUNTING_VERSION, day: expectedDay, providers, ...(legacyCarry ? { legacyCarry } : {}) };
}

function parseIdentity(value: unknown, expectedId: string): StoredIdentity {
  if (!isRecord(value)) throw new Error("Invalid review accounting identity.");
  exactKeys(value, ["version", "id", "day", "provider", "jobDigest", "claimAttempt", "leaseToken", "reservedAt", "holdTokens", "holdCostNanodollars"], ["jobId"]);
  if (value.version !== REVIEW_ACCOUNTING_VERSION || value.id !== expectedId || typeof value.jobDigest !== "string"
    || !DIGEST.test(value.jobDigest) || typeof value.leaseToken !== "string" || !LEASE_TOKEN.test(value.leaseToken)) {
    throw new Error("Invalid review accounting identity.");
  }
  if (value.jobId !== undefined && (typeof value.jobId !== "string" || !JOB_ID.test(value.jobId))) {
    throw new Error("Invalid review accounting identity job id.");
  }
  const identity: StoredIdentity = {
    version: REVIEW_ACCOUNTING_VERSION,
    id: expectedId,
    day: checkedDay(value.day),
    provider: checkedProvider(value.provider),
    ...(value.jobId === undefined ? {} : { jobId: value.jobId as string }),
    jobDigest: value.jobDigest,
    claimAttempt: positiveInteger(value.claimAttempt, "review accounting identity attempt"),
    leaseToken: value.leaseToken,
    reservedAt: checkedIso(value.reservedAt, "review accounting identity reservation timestamp"),
    holdTokens: positiveInteger(value.holdTokens, "review accounting identity token hold"),
    holdCostNanodollars: nonnegativeInteger(value.holdCostNanodollars, "review accounting identity cost hold"),
  };
  if (reviewAttemptId({ jobDigest: identity.jobDigest, attempt: identity.claimAttempt, leaseToken: identity.leaseToken }) !== expectedId) {
    throw new Error("Invalid review accounting deterministic identity.");
  }
  return identity;
}

function emptyDay(day: string): StoredDay {
  return { version: REVIEW_ACCOUNTING_VERSION, day, providers: Object.create(null) as Record<string, StoredAttempt[]> };
}

function zero(): ReviewBudgetAmount {
  return { calls: 0, tokens: 0, costNanodollars: 0 };
}

function add(target: ReviewBudgetAmount, source: ReviewBudgetAmount): void {
  target.calls += source.calls;
  target.tokens += source.tokens;
  target.costNanodollars += source.costNanodollars;
  if (![target.calls, target.tokens, target.costNanodollars].every(Number.isSafeInteger)) {
    throw new Error("Review accounting budget total overflow.");
  }
}

function budgetFor(day: StoredDay, provider: string): Omit<ReviewBudgetSnapshot, "version" | "day" | "provider"> {
  const charged = zero();
  const held = zero();
  const unknown = zero();
  const carry = day.legacyCarry?.[provider];
  if (carry) add(unknown, { calls: carry.calls, tokens: carry.tokens, costNanodollars: carry.costNanodollars });
  for (const attempt of day.providers[provider] ?? []) {
    if (attempt.state === "settled") add(charged, { calls: 1, tokens: attempt.chargedTokens!, costNanodollars: attempt.chargedCostNanodollars! });
    else if (attempt.state === "reserved" || attempt.state === "dispatched") add(held, { calls: 1, tokens: attempt.holdTokens, costNanodollars: attempt.holdCostNanodollars });
    else if (attempt.state === "unknown") add(unknown, { calls: 1, tokens: attempt.holdTokens, costNanodollars: attempt.holdCostNanodollars });
  }
  const effective = { ...charged };
  add(effective, held);
  add(effective, unknown);
  return { charged, held, unknown, effective };
}

function checkedClaim(value: ReviewAttemptClaim): ReviewAttemptClaim {
  if (!isRecord(value) || typeof value.jobDigest !== "string" || !DIGEST.test(value.jobDigest)
    || (value.jobId !== undefined && (typeof value.jobId !== "string" || !JOB_ID.test(value.jobId)))
    || typeof value.leaseToken !== "string" || !LEASE_TOKEN.test(value.leaseToken)) {
    throw new Error("Invalid review accounting claim.");
  }
  return {
    ...(value.jobId === undefined ? {} : { jobId: value.jobId }),
    jobDigest: value.jobDigest,
    attempt: positiveInteger(value.attempt, "review accounting claim attempt"),
    leaseToken: value.leaseToken,
  };
}

function checkedLimits(value: ReviewDailyBudgetLimits): ReviewDailyBudgetLimits {
  if (!isRecord(value)) throw new Error("Invalid review accounting limits.");
  return {
    maxCalls: positiveInteger(value.maxCalls, "daily review call limit"),
    maxTokens: positiveInteger(value.maxTokens, "daily review token limit"),
    maxCostNanodollars: positiveInteger(value.maxCostNanodollars, "daily review cost limit"),
  };
}

function checkedHold(value: ReviewAttemptHold): ReviewAttemptHold {
  if (!isRecord(value)) throw new Error("Invalid review accounting hold.");
  return {
    tokens: positiveInteger(value.tokens, "review accounting token hold"),
    costNanodollars: nonnegativeInteger(value.costNanodollars, "review accounting cost hold"),
  };
}

function checkedLegacyBudget(value: LegacyReviewDailyBudget): LegacyReviewDailyBudget {
  if (!isRecord(value)) throw new Error("Invalid legacy review budget.");
  exactKeys(value, ["version", "day", "calls", "tokens", "costUsd"]);
  if (value.version !== 1 || typeof value.costUsd !== "number" || !Number.isFinite(value.costUsd) || value.costUsd < 0) {
    throw new Error("Invalid legacy review budget.");
  }
  return {
    version: 1,
    day: checkedDay(value.day),
    calls: nonnegativeInteger(value.calls, "legacy review calls"),
    tokens: nonnegativeInteger(value.tokens, "legacy review tokens"),
    costUsd: value.costUsd,
  };
}

function dispatchOf(attempt: StoredAttempt): ReviewAttemptDispatch | undefined {
  if (attempt.requestDigest === undefined) return undefined;
  return { requestDigest: attempt.requestDigest, model: attempt.model!, api: attempt.api! };
}

function dispatchMatches(attempt: StoredAttempt, dispatch: ReviewAttemptDispatch): boolean {
  return attempt.requestDigest === dispatch.requestDigest && attempt.model === dispatch.model && attempt.api === dispatch.api;
}

function handleOf(attempt: StoredAttempt, day: string): ReviewAttemptReservation {
  return { version: REVIEW_ACCOUNTING_VERSION, id: attempt.id, day, provider: attempt.provider };
}

function checkedReservation(value: ReviewAttemptReservation): ReviewAttemptReservation {
  if (!isRecord(value) || value.version !== REVIEW_ACCOUNTING_VERSION || typeof value.id !== "string" || !ATTEMPT_ID.test(value.id)) {
    throw new Error("Invalid review accounting reservation.");
  }
  return { version: REVIEW_ACCOUNTING_VERSION, id: value.id, day: checkedDay(value.day), provider: checkedProvider(value.provider) };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

export function reviewAttemptId(claim: ReviewAttemptClaim): string {
  const checked = checkedClaim(claim);
  const digest = createHash("sha256")
    .update(`${checked.jobDigest}\n${checked.attempt}\n${checked.leaseToken}`, "utf8")
    .digest("hex")
    .slice(0, 40);
  return `review_attempt_${digest}`;
}

export function usdToNanodollars(usd: number): number {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) throw new Error("Invalid review accounting USD cost.");
  const value = Math.round(usd * 1_000_000_000);
  if (!Number.isSafeInteger(value)) throw new Error("Review accounting USD cost is too large.");
  return value;
}

/** Filesystem authority for provider attempts. Reservation day remains fixed through later UTC rollover. */
export class FileReviewAttemptAccounting implements ReviewAttemptAccounting {
  readonly root: string;
  readonly accountingDir: string;
  readonly daysDir: string;
  readonly identitiesDir: string;

  private readonly lockPath: string;
  private readonly clock: () => Date;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(root: string, options: FileReviewAttemptAccountingOptions = {}) {
    if (!root) throw new Error("Review accounting root is required.");
    this.root = resolve(root);
    this.accountingDir = join(this.root, "accounting");
    this.daysDir = join(this.accountingDir, "days");
    this.identitiesDir = join(this.accountingDir, "identities");
    this.lockPath = join(this.accountingDir, ".lock");
    this.clock = options.now ?? (() => new Date());
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? 5_000, "review accounting lock timeout");
    this.staleLockMs = positiveInteger(options.staleLockMs ?? 30_000, "review accounting stale-lock timeout");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.daysDir, { recursive: true, mode: 0o700 }),
      mkdir(this.identitiesDir, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([chmod(this.accountingDir, 0o700), chmod(this.daysDir, 0o700), chmod(this.identitiesDir, 0o700)]);
  }

  async reserve(request: ReviewAttemptReservationRequest): Promise<ReviewAttemptReservation | undefined> {
    const claim = checkedClaim(request.claim);
    const provider = checkedProvider(request.provider);
    const limits = checkedLimits(request.limits);
    const hold = checkedHold(request.hold);
    if (hold.tokens > limits.maxTokens || hold.costNanodollars > limits.maxCostNanodollars) return undefined;
    const id = reviewAttemptId(claim);
    const now = checkedClock(this.clock);
    const dayName = utcDay(now);
    return this.lock(async () => {
      const identity = await this.readIdentity(id);
      if (identity) {
        if (identity.provider !== provider || identity.jobDigest !== claim.jobDigest || identity.claimAttempt !== claim.attempt
          || identity.leaseToken !== claim.leaseToken || identity.holdTokens !== hold.tokens
          || identity.holdCostNanodollars !== hold.costNanodollars) {
          throw new Error("Conflicting review accounting reservation.");
        }
        const originalDay = await this.readDay(identity.day);
        let existing = Object.values(originalDay.providers).flat().find((attempt) => attempt.id === id);
        if (!existing) {
          // Identity publication precedes aggregate publication. Repair only on
          // its original current UTC day; a missing old day was already retired.
          if (identity.day !== dayName) throw new Error("Review accounting attempt identity was retired.");
          existing = this.attemptFromIdentity(identity);
          originalDay.providers[provider] = [...(originalDay.providers[provider] ?? []), existing];
          await this.writeDay(originalDay);
        }
        if (existing.state === "canceled") throw new Error("Review accounting attempt was canceled.");
        return handleOf(existing, identity.day);
      }

      const day = await this.readDay(dayName);
      const usage = budgetFor(day, provider).effective;
      if (usage.calls + 1 > limits.maxCalls || usage.tokens + hold.tokens > limits.maxTokens
        || usage.costNanodollars + hold.costNanodollars > limits.maxCostNanodollars) return undefined;
      const storedIdentity: StoredIdentity = {
        version: REVIEW_ACCOUNTING_VERSION,
        id,
        day: dayName,
        provider,
        ...(claim.jobId === undefined ? {} : { jobId: claim.jobId }),
        jobDigest: claim.jobDigest,
        claimAttempt: claim.attempt,
        leaseToken: claim.leaseToken,
        reservedAt: now.toISOString(),
        holdTokens: hold.tokens,
        holdCostNanodollars: hold.costNanodollars,
      };
      await this.writeIdentity(storedIdentity);
      const attempt = this.attemptFromIdentity(storedIdentity);
      day.providers[provider] = [...(day.providers[provider] ?? []), attempt];
      await this.writeDay(day);
      return handleOf(attempt, dayName);
    });
  }

  commitDispatch(reservation: ReviewAttemptReservation, dispatchValue?: ReviewAttemptDispatch): Promise<void> {
    const dispatch = dispatchValue === undefined ? undefined : checkedDispatch(dispatchValue);
    return this.mutate(reservation, (attempt, now) => {
      if (attempt.state === "dispatched" || attempt.state === "settled" || attempt.state === "unknown") {
        const stored = dispatchOf(attempt);
        if (dispatch && stored && !dispatchMatches(attempt, dispatch)) throw new Error("Conflicting review accounting dispatch replay.");
        if (dispatch && !stored) {
          attempt.requestDigest = dispatch.requestDigest;
          attempt.model = dispatch.model;
          attempt.api = dispatch.api;
          return true;
        }
        return false;
      }
      if (attempt.state !== "reserved") throw new Error("Only a reserved review attempt can be dispatched.");
      attempt.state = "dispatched";
      attempt.dispatchedAt = now;
      if (dispatch) {
        attempt.requestDigest = dispatch.requestDigest;
        attempt.model = dispatch.model;
        attempt.api = dispatch.api;
      }
      return true;
    });
  }

  settle(reservation: ReviewAttemptReservation, provenance: ReviewModelProvenance): Promise<void> {
    const parsed = parseProvenance(provenance);
    return this.mutate(reservation, (attempt, now) => {
      if (parsed.provider !== attempt.provider) throw new Error("Review accounting provenance provider does not match reservation.");
      if (attempt.model !== undefined && (attempt.model !== parsed.model || attempt.api !== parsed.api)) {
        throw new Error("Review accounting provenance does not match dispatched model/API.");
      }
      const cost = usdToNanodollars(parsed.usage.cost.total);
      if (attempt.state === "settled") {
        if (attempt.chargedTokens !== parsed.usage.totalTokens || attempt.chargedCostNanodollars !== cost
          || canonical(attempt.provenance) !== canonical(parsed)) throw new Error("Conflicting review accounting settlement.");
        return false;
      }
      if (attempt.state !== "dispatched" && attempt.state !== "unknown") {
        throw new Error("Only a dispatched review attempt can be settled.");
      }
      attempt.state = "settled";
      delete attempt.unknownAt;
      attempt.settledAt = now;
      attempt.chargedTokens = parsed.usage.totalTokens;
      attempt.chargedCostNanodollars = cost;
      attempt.provenance = parsed;
      return true;
    });
  }

  markUnknown(reservation: ReviewAttemptReservation): Promise<void> {
    return this.mutate(reservation, (attempt, now) => {
      if (attempt.state === "unknown") return false;
      if (attempt.state === "settled") throw new Error("Settled review accounting usage cannot become unknown.");
      if (attempt.state !== "dispatched") throw new Error("Only a dispatched review attempt can have unknown usage.");
      attempt.state = "unknown";
      attempt.unknownAt = now;
      return true;
    });
  }

  cancelPreDispatch(reservation: ReviewAttemptReservation): Promise<void> {
    return this.mutate(reservation, (attempt, now) => {
      if (attempt.state === "canceled") return false;
      if (attempt.state !== "reserved") throw new Error("A dispatched review attempt cannot be canceled.");
      attempt.state = "canceled";
      attempt.canceledAt = now;
      return true;
    });
  }

  async snapshot(providerValue: string, dayValue?: string): Promise<ReviewBudgetSnapshot> {
    const provider = checkedProvider(providerValue);
    const dayName = dayValue === undefined ? utcDay(checkedClock(this.clock)) : checkedDay(dayValue);
    return this.lock(async () => ({
      version: REVIEW_ACCOUNTING_VERSION,
      day: dayName,
      provider,
      ...budgetFor(await this.readDay(dayName), provider),
    }));
  }

  /** Imports one same-day v1 aggregate as conservative unknown exposure. */
  async importLegacyDailyBudget(providerValue: string, legacyValue: LegacyReviewDailyBudget): Promise<boolean> {
    const provider = checkedProvider(providerValue);
    const legacy = checkedLegacyBudget(legacyValue);
    const now = checkedClock(this.clock);
    const currentDay = utcDay(now);
    if (legacy.day !== currentDay) return false;
    const sourceDigest = createHash("sha256").update(canonical(legacy), "utf8").digest("hex");
    const importedAt = now.toISOString();
    return this.lock(async () => {
      const day = await this.readDay(currentDay);
      const existing = day.legacyCarry?.[provider];
      if (existing) {
        if (existing.sourceDigest !== sourceDigest) throw new Error("Conflicting legacy review budget import.");
        return false;
      }
      day.legacyCarry ??= Object.create(null) as Record<string, StoredLegacyCarry>;
      day.legacyCarry[provider] = {
        sourceDigest,
        importedAt,
        calls: legacy.calls,
        tokens: legacy.tokens,
        costNanodollars: usdToNanodollars(legacy.costUsd),
      };
      await this.writeDay(day);
      return true;
    });
  }

  /** Bounded, cursor-based enumeration over immutable attempt identities. */
  async listRecoveryCandidates(options: { limit: number; cursor?: string }): Promise<ReviewAttemptRecoveryPage> {
    const limit = positiveInteger(options.limit, "review accounting recovery limit");
    if (limit > MAX_REVIEW_ACCOUNTING_RECOVERY_BATCH) {
      throw new Error(`Review accounting recovery limit exceeds ${MAX_REVIEW_ACCOUNTING_RECOVERY_BATCH}.`);
    }
    if (options.cursor !== undefined && !ATTEMPT_ID.test(options.cursor)) throw new Error("Invalid review accounting recovery cursor.");
    return this.lock(async () => {
      const entries = await readdir(this.identitiesDir, { withFileTypes: true });
      if (entries.length > MAX_REVIEW_ACCOUNTING_RETENTION_ENTRIES) {
        throw new Error(`Review accounting identity scan exceeds ${MAX_REVIEW_ACCOUNTING_RETENTION_ENTRIES} entries.`);
      }
      for (const entry of entries) {
        if (!entry.isFile() || (!ATTEMPT_ID.test(entry.name) && !IDENTITY_TEMPORARY.test(entry.name))) {
          throw new Error("Invalid review accounting identity index entry.");
        }
      }
      const names = entries.map((entry) => entry.name).filter((name) => ATTEMPT_ID.test(name)).sort();
      const recoveryDay = utcDay(checkedClock(this.clock));
      const start = options.cursor === undefined ? 0 : names.findIndex((name) => name > options.cursor!);
      if (start < 0) return { candidates: [] };
      const scanned = names.slice(start, start + limit);
      const candidates: ReviewAttemptRecoveryCandidate[] = [];
      for (const id of scanned) {
        const identity = await this.readIdentity(id);
        if (!identity) throw new Error("Review accounting identity disappeared during recovery scan.");
        const day = await this.readDay(identity.day);
        let attempt = (day.providers[identity.provider] ?? []).find((candidate) => candidate.id === id);
        if (!attempt) {
          // Missing old authority means retention already proved it closed. A
          // current-day gap is the recoverable identity-before-aggregate window.
          if (identity.day !== recoveryDay) continue;
          attempt = this.attemptFromIdentity(identity);
          day.providers[identity.provider] = [...(day.providers[identity.provider] ?? []), attempt];
          await this.writeDay(day);
        }
        if (attempt.state !== "reserved" && attempt.state !== "dispatched") continue;
        candidates.push({
          reservation: handleOf(attempt, identity.day),
          claim: {
            ...(attempt.jobId === undefined ? {} : { jobId: attempt.jobId }),
            jobDigest: attempt.jobDigest,
            attempt: attempt.claimAttempt,
            leaseToken: attempt.leaseToken,
          },
          state: attempt.state,
          reservedAt: attempt.reservedAt,
          ...(attempt.dispatchedAt ? { dispatchedAt: attempt.dispatchedAt } : {}),
          ...(dispatchOf(attempt) ? { dispatch: dispatchOf(attempt)! } : {}),
        });
      }
      return {
        candidates,
        ...(start + scanned.length < names.length ? { nextCursor: scanned.at(-1)! } : {}),
      };
    });
  }

  /** Reconciles only caller-enumerated attempts; every collection is hard bounded. */
  async reconcileRecovery(request: ReviewAttemptRecoveryRequest): Promise<ReviewAttemptRecoveryReport> {
    if (!isRecord(request) || !Array.isArray(request.candidates) || !Array.isArray(request.liveLeaseTokens)
      || !Array.isArray(request.results) || request.candidates.length > MAX_REVIEW_ACCOUNTING_RECOVERY_BATCH
      || request.results.length > MAX_REVIEW_ACCOUNTING_RECOVERY_BATCH
      || request.liveLeaseTokens.length > MAX_REVIEW_ACCOUNTING_RETENTION_ENTRIES) {
      throw new Error("Invalid or oversized review accounting recovery request.");
    }
    const expiresBefore = checkedIso(request.expiresBefore, "review accounting recovery expiry");
    const candidates = request.candidates.map(checkedReservation);
    if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
      throw new Error("Duplicate review accounting recovery candidate.");
    }
    const live = new Set(request.liveLeaseTokens.map((token) => {
      if (typeof token !== "string" || !LEASE_TOKEN.test(token)) throw new Error("Invalid live review claim token.");
      return token;
    }));
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const results = new Map<string, { reservation: ReviewAttemptReservation; provenance: ReviewModelProvenance; dispatch?: ReviewAttemptDispatch }>();
    for (const raw of request.results) {
      if (!isRecord(raw)) throw new Error("Invalid review accounting recovery result.");
      const reservation = checkedReservation(raw.reservation as ReviewAttemptReservation);
      if (!candidateIds.has(reservation.id) || results.has(reservation.id)) throw new Error("Invalid review accounting recovery result membership.");
      const parsed = {
        reservation,
        provenance: parseProvenance(raw.provenance),
        ...(raw.dispatch === undefined ? {} : { dispatch: checkedDispatch(raw.dispatch as ReviewAttemptDispatch) }),
      };
      results.set(reservation.id, parsed);
    }
    const now = checkedClock(this.clock).toISOString();
    return this.lock(async () => {
      const report: ReviewAttemptRecoveryReport = { settled: [], canceled: [], unknown: [], unchanged: [] };
      const days = new Map<string, { day: StoredDay; changed: boolean }>();
      for (const reservation of candidates) {
        let loaded = days.get(reservation.day);
        if (!loaded) {
          loaded = { day: await this.readDay(reservation.day), changed: false };
          days.set(reservation.day, loaded);
        }
        const attempt = (loaded.day.providers[reservation.provider] ?? []).find((candidate) => candidate.id === reservation.id);
        if (!attempt) throw new Error("Unknown review accounting reservation.");
        const result = results.get(attempt.id);
        if (result) {
          if (result.reservation.day !== reservation.day || result.reservation.provider !== reservation.provider
            || result.provenance.provider !== attempt.provider) throw new Error("Conflicting review accounting recovery result.");
          if (attempt.state === "canceled") throw new Error("Canceled review accounting attempt conflicts with durable result.");
          if (result.dispatch) {
            if (dispatchOf(attempt) && !dispatchMatches(attempt, result.dispatch)) throw new Error("Conflicting review accounting dispatch replay.");
            attempt.requestDigest = result.dispatch.requestDigest;
            attempt.model = result.dispatch.model;
            attempt.api = result.dispatch.api;
          }
          if (attempt.model !== undefined && (attempt.model !== result.provenance.model || attempt.api !== result.provenance.api)) {
            throw new Error("Review accounting provenance does not match dispatched model/API.");
          }
          const chargedCost = usdToNanodollars(result.provenance.usage.cost.total);
          if (attempt.state === "settled") {
            if (attempt.chargedTokens !== result.provenance.usage.totalTokens || attempt.chargedCostNanodollars !== chargedCost
              || canonical(attempt.provenance) !== canonical(result.provenance)) throw new Error("Conflicting review accounting settlement.");
            report.unchanged.push(attempt.id);
            continue;
          }
          if (attempt.state === "reserved") attempt.dispatchedAt = result.provenance.startedAt;
          attempt.state = "settled";
          delete attempt.unknownAt;
          attempt.settledAt = now;
          attempt.chargedTokens = result.provenance.usage.totalTokens;
          attempt.chargedCostNanodollars = chargedCost;
          attempt.provenance = result.provenance;
          loaded.changed = true;
          report.settled.push(attempt.id);
          continue;
        }
        if (live.has(attempt.leaseToken)) {
          report.unchanged.push(attempt.id);
          continue;
        }
        const expiryBasis = attempt.state === "dispatched" ? attempt.dispatchedAt! : attempt.reservedAt;
        if (expiryBasis > expiresBefore || (attempt.state !== "reserved" && attempt.state !== "dispatched")) {
          report.unchanged.push(attempt.id);
          continue;
        }
        if (attempt.state === "reserved") {
          attempt.state = "canceled";
          attempt.canceledAt = now;
          report.canceled.push(attempt.id);
        } else {
          attempt.state = "unknown";
          attempt.unknownAt = now;
          report.unknown.push(attempt.id);
        }
        loaded.changed = true;
      }
      for (const loaded of days.values()) if (loaded.changed) await this.writeDay(loaded.day);
      return report;
    });
  }

  /** Removes only old, closed UTC-day records. Current and unresolved budget authority is retained. */
  async purgeClosedDaysBefore(cutoff: Date): Promise<number> {
    if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) {
      throw new Error("Invalid review accounting retention cutoff.");
    }
    const cutoffMs = cutoff.getTime();
    return this.lock(async () => {
      const currentDay = utcDay(checkedClock(this.clock));
      const entries = await readdir(this.daysDir, { withFileTypes: true });
      if (entries.length > MAX_REVIEW_ACCOUNTING_RETENTION_ENTRIES) {
        throw new Error(`Review accounting retention scan exceeds ${MAX_REVIEW_ACCOUNTING_RETENTION_ENTRIES} entries.`);
      }
      let removed = 0;
      for (const entry of entries) {
        const path = join(this.daysDir, entry.name);
        const temporary = DAY_TEMPORARY.exec(entry.name);
        if (temporary) {
          const temporaryDay = checkedDay(temporary[1]);
          if (temporaryDay === currentDay) continue;
          const info = await lstat(path);
          if (!info.isFile()) throw new Error(`Review accounting temporary is not a regular file: ${path}`);
          if (info.mtimeMs < cutoffMs && await durableUnlink(path)) removed += 1;
          continue;
        }
        const dayName = checkedDay(entry.name);
        if (!entry.isFile()) throw new Error(`Review accounting day is not a regular file: ${path}`);
        if (dayName === currentDay) continue;
        const info = await lstat(path);
        if (!info.isFile()) throw new Error(`Review accounting day is not a regular file: ${path}`);
        if (info.mtimeMs >= cutoffMs) continue;
        const day = await this.readDay(dayName);
        const closed = Object.values(day.providers).every((attempts) =>
          attempts.every((attempt) => attempt.state === "settled" || attempt.state === "canceled")
        );
        if (closed && await durableUnlink(path)) removed += 1;
      }
      const identityEntries = await readdir(this.identitiesDir, { withFileTypes: true });
      if (identityEntries.length > MAX_REVIEW_ACCOUNTING_RETENTION_ENTRIES) {
        throw new Error(`Review accounting identity retention scan exceeds ${MAX_REVIEW_ACCOUNTING_RETENTION_ENTRIES} entries.`);
      }
      for (const entry of identityEntries) {
        if (ATTEMPT_ID.test(entry.name)) {
          if (!entry.isFile()) throw new Error("Review accounting identity is not a regular file.");
          continue;
        }
        const path = join(this.identitiesDir, entry.name);
        if (!IDENTITY_TEMPORARY.test(entry.name)) throw new Error("Invalid review accounting identity retention entry.");
        const info = await lstat(path);
        if (!info.isFile()) throw new Error("Review accounting identity temporary is not a regular file.");
        if (info.mtimeMs < cutoffMs && await durableUnlink(path)) removed += 1;
      }
      return removed;
    });
  }

  private attemptFromIdentity(identity: StoredIdentity): StoredAttempt {
    return {
      id: identity.id,
      ...(identity.jobId === undefined ? {} : { jobId: identity.jobId }),
      jobDigest: identity.jobDigest,
      claimAttempt: identity.claimAttempt,
      leaseToken: identity.leaseToken,
      provider: identity.provider,
      state: "reserved",
      reservedAt: identity.reservedAt,
      holdTokens: identity.holdTokens,
      holdCostNanodollars: identity.holdCostNanodollars,
    };
  }

  private async readIdentity(id: string): Promise<StoredIdentity | undefined> {
    if (!ATTEMPT_ID.test(id)) throw new Error("Invalid review accounting identity id.");
    const path = join(this.identitiesDir, id);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await file.stat();
      if (!info.isFile() || info.size <= 0 || info.size > MAX_REVIEW_ACCOUNTING_IDENTITY_BYTES) {
        throw new Error("Invalid review accounting identity file size.");
      }
      if ((info.mode & 0o777) !== 0o600) throw new Error("Review accounting identity file must be private 0600.");
      const bytes = await file.readFile();
      if (bytes.byteLength > MAX_REVIEW_ACCOUNTING_IDENTITY_BYTES) throw new Error("Review accounting identity file is oversized.");
      return parseIdentity(JSON.parse(bytes.toString("utf8")) as unknown, id);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    } finally {
      await file?.close();
    }
  }

  private async writeIdentity(identity: StoredIdentity): Promise<void> {
    const encoded = `${JSON.stringify(identity)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_REVIEW_ACCOUNTING_IDENTITY_BYTES) {
      throw new Error("Review accounting identity file is oversized.");
    }
    await atomicCreateFile(join(this.identitiesDir, identity.id), encoded);
    await chmod(join(this.identitiesDir, identity.id), 0o600);
  }

  private async mutate(
    reservationValue: ReviewAttemptReservation,
    change: (attempt: StoredAttempt, now: string) => boolean,
  ): Promise<void> {
    const reservation = checkedReservation(reservationValue);
    const now = checkedClock(this.clock).toISOString();
    await this.lock(async () => {
      const day = await this.readDay(reservation.day);
      const attempt = (day.providers[reservation.provider] ?? []).find((candidate) => candidate.id === reservation.id);
      if (!attempt) throw new Error("Unknown review accounting reservation.");
      if (change(attempt, now)) await this.writeDay(day);
    });
  }

  private async readDay(day: string): Promise<StoredDay> {
    const path = this.dayPath(day);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await file.stat();
      if (!info.isFile() || info.size <= 0 || info.size > MAX_REVIEW_ACCOUNTING_DAY_BYTES) {
        throw new Error("Invalid review accounting day file size.");
      }
      if ((info.mode & 0o777) !== 0o600) throw new Error("Review accounting day file must be private 0600.");
      const bytes = await file.readFile();
      if (bytes.byteLength > MAX_REVIEW_ACCOUNTING_DAY_BYTES) throw new Error("Review accounting day file is oversized.");
      return parseDay(JSON.parse(bytes.toString("utf8")) as unknown, day);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return emptyDay(day);
      throw error;
    } finally {
      await file?.close();
    }
  }

  private async writeDay(day: StoredDay): Promise<void> {
    const encoded = `${JSON.stringify(day)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_REVIEW_ACCOUNTING_DAY_BYTES) {
      throw new Error("Review accounting day file is oversized.");
    }
    await atomicWriteFile(this.dayPath(day.day), encoded);
    await chmod(this.dayPath(day.day), 0o600);
  }

  private dayPath(day: string): string {
    return join(this.daysDir, checkedDay(day));
  }

  private async lock<T>(fn: () => Promise<T>): Promise<T> {
    await this.initialize();
    return withFileLock(this.lockPath, this.lockTimeoutMs, this.staleLockMs, "review accounting", fn);
  }
}
