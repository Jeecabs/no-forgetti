import { createHash } from "node:crypto";

import { memoryBranchDigest } from "../store.ts";
import type { MemoryBranch, MemoryImportance, MemoryWriteOrigin, ReviewOperation } from "../types.ts";

export const REVIEW_PROTOCOL_VERSION = 1 as const;
export const MAX_REVIEW_JOB_BYTES = 128 * 1024;
export const MAX_REVIEW_OUTCOME_BYTES = 16 * 1024;
export const MAX_REVIEW_TRANSCRIPT_CHARS = 32_000;
export const MAX_REVIEW_MEMORY_ENTRIES = 512;
export const MAX_REVIEW_MEMORY_CHARS = 64_000;

const PROJECT_KEY = /^[0-9a-f]{16,64}$/u;
const SESSION_KEY = /^[0-9a-f]{32}$/u;
const JOB_ID = /^review_[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const BRANCH_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;
const ERROR_CODE = /^[a-z][a-z0-9_-]{0,63}$/u;
const FORBIDDEN_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/giu, "[REDACTED PRIVATE KEY]"],
  [/\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/gu, "[REDACTED TOKEN]"],
  [/\b((?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*)\S{8,}/giu, "$1[REDACTED]"],
];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ReviewMemoryEntry {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: MemoryWriteOrigin;
  updatedBy?: MemoryWriteOrigin;
  importance: MemoryImportance;
  importanceAssessedAt?: string;
}

export interface ReviewMemoryBranch {
  version: 1;
  name: string;
  parent?: string;
  createdAt: string;
  updatedAt: string;
  entries: ReviewMemoryEntry[];
}

/** Immutable, sanitized transport envelope. It never contains a raw session id or project path. */
export interface ReviewJob {
  version: typeof REVIEW_PROTOCOL_VERSION;
  kind: "memory-review";
  id: string;
  digest: string;
  projectKey: string;
  sessionKey: string;
  throughEntryId: string;
  transcript: string;
  branch: ReviewMemoryBranch;
  baseBranchDigest: string;
  maxChars: number;
}

export interface ReviewJobRequest {
  projectKey: string;
  sessionId: string;
  throughEntryId: string;
  transcript: string;
  branch: MemoryBranch | ReviewMemoryBranch;
  baseBranchDigest?: string;
  maxChars: number;
}

export interface ReviewFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ReviewModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface ReviewModelProvenance {
  provider: string;
  model: string;
  api: string;
  responseModel?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  usage: ReviewModelUsage;
}

export type ReviewOutcome =
  | {
    version: typeof REVIEW_PROTOCOL_VERSION;
    jobId: string;
    jobDigest: string;
    status: "completed";
    completedAt: string;
    operations: ReviewOperation[];
    provenance: ReviewModelProvenance;
  }
  | {
    version: typeof REVIEW_PROTOCOL_VERSION;
    jobId: string;
    jobDigest: string;
    status: "failed";
    completedAt: string;
    error: ReviewFailure;
    provenance?: ReviewModelProvenance;
  };

export type ReviewOutcomeResult =
  | { status: "completed"; completedAt?: string; operations: ReviewOperation[]; provenance: ReviewModelProvenance }
  | { status: "failed"; completedAt?: string; error: ReviewFailure; provenance?: ReviewModelProvenance };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    throw new Error("Invalid review protocol object shape.");
  }
}

function checkedString(value: unknown, label: string, maxChars: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars || (pattern && !pattern.test(value))) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function checkedIso(value: unknown, label: string): string {
  const timestamp = checkedString(value, label, 32);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) throw new Error(`Invalid ${label}.`);
  return timestamp;
}

function checkedPositiveInteger(value: unknown, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error(`Invalid ${label}.`);
  return value as number;
}

function canonicalize(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedJson(value: Json, maxBytes: number, label: string): string {
  const encoded = canonicalize(value);
  if (byteLength(encoded) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`);
  return encoded;
}

function parseBoundedJson(input: string | Uint8Array, maxBytes: number, label: string): unknown {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (bytes.byteLength === 0) throw new Error(`${label} is empty.`);
  if (bytes.byteLength > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`);
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

/** Normalize line endings, remove hidden controls, and redact common credential forms. */
export function sanitizeReviewText(input: string): string {
  if (typeof input !== "string") throw new Error("Invalid review text.");
  let value = input.replace(/\r\n?/gu, "\n").replace(FORBIDDEN_CONTROLS, "\uFFFD").normalize("NFC");
  for (const [pattern, replacement] of SECRET_PATTERNS) value = value.replace(pattern, replacement);
  return value;
}

export function reviewSessionKey(sessionId: string): string {
  const normalized = checkedString(sessionId, "review session id", 512);
  if (normalized !== normalized.trim()) throw new Error("Invalid review session id.");
  return sha256(normalized).slice(0, 32);
}

function parseImportance(value: unknown): MemoryImportance {
  if (value !== "high" && value !== "normal" && value !== "low") throw new Error("Invalid review memory importance.");
  return value;
}

function parseOrigin(value: unknown, label: string): MemoryWriteOrigin | undefined {
  if (value === undefined) return undefined;
  if (value !== "assistant_tool" && value !== "background_review") throw new Error(`Invalid ${label}.`);
  return value;
}

function sanitizeEntry(value: unknown, sanitize: boolean): ReviewMemoryEntry {
  if (!isRecord(value)) throw new Error("Invalid review memory entry.");
  exactKeys(value, ["id", "text", "createdAt", "updatedAt", "importance"], [
    ...(sanitize ? ["sourceSessionId"] : []), "createdBy", "updatedBy", "importanceAssessedAt",
  ]);
  const originalText = checkedString(value.text, "review memory text", 4_000);
  const text = sanitizeReviewText(originalText);
  if (!sanitize && text !== originalText) throw new Error("Review memory text is not sanitized.");
  const entry: ReviewMemoryEntry = {
    id: checkedString(value.id, "review memory entry id", 256, SAFE_ID),
    text,
    createdAt: checkedIso(value.createdAt, "review memory creation timestamp"),
    updatedAt: checkedIso(value.updatedAt, "review memory update timestamp"),
    importance: parseImportance(value.importance),
  };
  const createdBy = parseOrigin(value.createdBy, "review memory creation origin");
  const updatedBy = parseOrigin(value.updatedBy, "review memory update origin");
  if (createdBy) entry.createdBy = createdBy;
  if (updatedBy) entry.updatedBy = updatedBy;
  if (value.importanceAssessedAt !== undefined) {
    entry.importanceAssessedAt = checkedIso(value.importanceAssessedAt, "review memory assessment timestamp");
  }
  return entry;
}

function sanitizeBranch(value: unknown, sanitize: boolean): ReviewMemoryBranch {
  if (!isRecord(value)) throw new Error("Invalid review memory branch.");
  exactKeys(value, ["version", "name", "createdAt", "updatedAt", "entries"], ["parent"]);
  if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_REVIEW_MEMORY_ENTRIES) {
    throw new Error("Invalid review memory branch.");
  }
  const entries = value.entries.map((entry) => sanitizeEntry(entry, sanitize));
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("Duplicate review memory entry id.");
  if (entries.reduce((sum, entry) => sum + entry.text.length, 0) > MAX_REVIEW_MEMORY_CHARS) {
    throw new Error(`Review memory exceeds ${MAX_REVIEW_MEMORY_CHARS} characters.`);
  }
  const branch: ReviewMemoryBranch = {
    version: 1,
    name: checkedString(value.name, "review memory branch name", 64, BRANCH_NAME),
    createdAt: checkedIso(value.createdAt, "review memory branch creation timestamp"),
    updatedAt: checkedIso(value.updatedAt, "review memory branch update timestamp"),
    entries,
  };
  if (value.parent !== undefined) branch.parent = checkedString(value.parent, "review memory parent branch", 64, BRANCH_NAME);
  return branch;
}

function jobIdentity(job: Pick<ReviewJob, "projectKey" | "sessionKey" | "throughEntryId" | "branch">): string {
  return `review_${sha256(canonicalize({
    version: REVIEW_PROTOCOL_VERSION,
    kind: "memory-review",
    projectKey: job.projectKey,
    sessionKey: job.sessionKey,
    branchName: job.branch.name,
    throughEntryId: job.throughEntryId,
  })).slice(0, 40)}`;
}

function jobDigest(job: Omit<ReviewJob, "id" | "digest">): string {
  return sha256(canonicalize(job as unknown as Json));
}

function jobJson(job: ReviewJob): Json {
  return job as unknown as Json;
}

export function createReviewJob(request: ReviewJobRequest): ReviewJob {
  const originalTranscript = checkedString(request.transcript, "review transcript", MAX_REVIEW_TRANSCRIPT_CHARS);
  const transcript = sanitizeReviewText(originalTranscript);
  const projectKey = checkedString(request.projectKey, "review project key", 64, PROJECT_KEY);
  const sessionKey = reviewSessionKey(request.sessionId);
  const throughEntryId = checkedString(request.throughEntryId, "review through-entry id", 256, SAFE_ID);
  const branch = sanitizeBranch(request.branch, true);
  const baseBranchDigest = request.baseBranchDigest === undefined
    ? memoryBranchDigest(request.branch as MemoryBranch)
    : checkedString(request.baseBranchDigest, "review base branch digest", 64, DIGEST);
  const maxChars = checkedPositiveInteger(request.maxChars, "review memory capacity", MAX_REVIEW_MEMORY_CHARS);
  const core: Omit<ReviewJob, "id" | "digest"> = {
    version: REVIEW_PROTOCOL_VERSION,
    kind: "memory-review",
    projectKey,
    sessionKey,
    throughEntryId,
    transcript,
    branch,
    baseBranchDigest,
    maxChars,
  };
  const job: ReviewJob = { ...core, id: jobIdentity(core), digest: jobDigest(core) };
  encodeReviewJob(job);
  return job;
}

export function parseReviewJob(value: unknown): ReviewJob {
  if (!isRecord(value)) throw new Error("Invalid review job envelope.");
  exactKeys(value, [
    "version", "kind", "id", "digest", "projectKey", "sessionKey", "throughEntryId", "transcript", "branch", "baseBranchDigest", "maxChars",
  ]);
  if (value.version !== REVIEW_PROTOCOL_VERSION || value.kind !== "memory-review") throw new Error("Unsupported review job version or kind.");
  const transcript = checkedString(value.transcript, "review transcript", MAX_REVIEW_TRANSCRIPT_CHARS);
  if (sanitizeReviewText(transcript) !== transcript) throw new Error("Review transcript is not sanitized.");
  const core: Omit<ReviewJob, "id" | "digest"> = {
    version: REVIEW_PROTOCOL_VERSION,
    kind: "memory-review",
    projectKey: checkedString(value.projectKey, "review project key", 64, PROJECT_KEY),
    sessionKey: checkedString(value.sessionKey, "review session key", 32, SESSION_KEY),
    throughEntryId: checkedString(value.throughEntryId, "review through-entry id", 256, SAFE_ID),
    transcript,
    branch: sanitizeBranch(value.branch, false),
    baseBranchDigest: checkedString(value.baseBranchDigest, "review base branch digest", 64, DIGEST),
    maxChars: checkedPositiveInteger(value.maxChars, "review memory capacity", MAX_REVIEW_MEMORY_CHARS),
  };
  const id = checkedString(value.id, "review job id", 47, JOB_ID);
  const digest = checkedString(value.digest, "review job digest", 64, DIGEST);
  if (id !== jobIdentity(core)) throw new Error("Review job id does not match its identity fields.");
  if (digest !== jobDigest(core)) throw new Error("Review job digest does not match its contents.");
  const job: ReviewJob = { ...core, id, digest };
  boundedJson(jobJson(job), MAX_REVIEW_JOB_BYTES, "Review job");
  return job;
}

export function encodeReviewJob(job: ReviewJob): string {
  const parsed = parseReviewJob(job);
  return boundedJson(jobJson(parsed), MAX_REVIEW_JOB_BYTES, "Review job");
}

export function decodeReviewJob(input: string | Uint8Array): ReviewJob {
  return parseReviewJob(parseBoundedJson(input, MAX_REVIEW_JOB_BYTES, "Review job"));
}

function requiredOperationString(value: Record<string, unknown>, key: string, maxChars: number): string {
  return checkedString(value[key], `review operation ${key}`, maxChars, key === "entryId" ? SAFE_ID : undefined);
}

function parseOperation(value: unknown): ReviewOperation {
  if (!isRecord(value) || typeof value.action !== "string") throw new Error("Invalid review operation.");
  switch (value.action) {
    case "add":
      exactKeys(value, ["action", "content", "importance"]);
      return { action: "add", content: sanitizeOperationText(value.content), importance: parseImportance(value.importance) };
    case "replace":
      exactKeys(value, ["action", "entryId", "content", "importance"]);
      return {
        action: "replace",
        entryId: requiredOperationString(value, "entryId", 256),
        content: sanitizeOperationText(value.content),
        importance: parseImportance(value.importance),
      };
    case "remove":
      exactKeys(value, ["action", "entryId"]);
      return { action: "remove", entryId: requiredOperationString(value, "entryId", 256) };
    case "merge": {
      exactKeys(value, ["action", "entryIds", "content", "importance"]);
      if (!Array.isArray(value.entryIds) || value.entryIds.length < 2 || value.entryIds.length > 16) throw new Error("Invalid review merge entry ids.");
      const entryIds = value.entryIds.map((entryId) => checkedString(entryId, "review merge entry id", 256, SAFE_ID));
      if (new Set(entryIds).size !== entryIds.length) throw new Error("Duplicate review merge entry id.");
      return { action: "merge", entryIds, content: sanitizeOperationText(value.content), importance: parseImportance(value.importance) };
    }
    case "assess":
      exactKeys(value, ["action", "entryId", "importance"]);
      return {
        action: "assess",
        entryId: requiredOperationString(value, "entryId", 256),
        importance: parseImportance(value.importance),
      };
    default:
      throw new Error("Invalid review operation action.");
  }
}

function sanitizeOperationText(value: unknown): string {
  const text = checkedString(value, "review operation content", 4_000);
  if (sanitizeReviewText(text) !== text) throw new Error("Review operation content is not sanitized.");
  return text;
}

function parseFailure(value: unknown): ReviewFailure {
  if (!isRecord(value)) throw new Error("Invalid review failure.");
  exactKeys(value, ["code", "message", "retryable"]);
  const message = checkedString(value.message, "review failure message", 2_000);
  if (sanitizeReviewText(message) !== message || typeof value.retryable !== "boolean") throw new Error("Invalid review failure.");
  return {
    code: checkedString(value.code, "review failure code", 64, ERROR_CODE),
    message,
    retryable: value.retryable,
  };
}

function nonnegativeNumber(value: unknown, label: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function parseUsage(value: unknown): ReviewModelUsage {
  if (!isRecord(value)) throw new Error("Invalid review model usage.");
  exactKeys(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"], ["reasoning"]);
  if (!isRecord(value.cost)) throw new Error("Invalid review model cost.");
  exactKeys(value.cost, ["input", "output", "cacheRead", "cacheWrite", "total"]);
  return {
    input: nonnegativeNumber(value.input, "review input tokens", true),
    output: nonnegativeNumber(value.output, "review output tokens", true),
    cacheRead: nonnegativeNumber(value.cacheRead, "review cache-read tokens", true),
    cacheWrite: nonnegativeNumber(value.cacheWrite, "review cache-write tokens", true),
    ...(value.reasoning === undefined ? {} : { reasoning: nonnegativeNumber(value.reasoning, "review reasoning tokens", true) }),
    totalTokens: nonnegativeNumber(value.totalTokens, "review total tokens", true),
    cost: {
      input: nonnegativeNumber(value.cost.input, "review input cost"),
      output: nonnegativeNumber(value.cost.output, "review output cost"),
      cacheRead: nonnegativeNumber(value.cost.cacheRead, "review cache-read cost"),
      cacheWrite: nonnegativeNumber(value.cost.cacheWrite, "review cache-write cost"),
      total: nonnegativeNumber(value.cost.total, "review total cost"),
    },
  };
}

function parseProvenance(value: unknown): ReviewModelProvenance {
  if (!isRecord(value)) throw new Error("Invalid review model provenance.");
  exactKeys(value, ["provider", "model", "api", "startedAt", "completedAt", "durationMs", "usage"], ["responseModel"]);
  const startedAt = checkedIso(value.startedAt, "review model start timestamp");
  const completedAt = checkedIso(value.completedAt, "review model completion timestamp");
  if (completedAt < startedAt) throw new Error("Review model completion precedes its start.");
  const provenance: ReviewModelProvenance = {
    provider: checkedString(value.provider, "review model provider", 128),
    model: checkedString(value.model, "review model", 256),
    api: checkedString(value.api, "review model API", 128),
    startedAt,
    completedAt,
    durationMs: nonnegativeNumber(value.durationMs, "review model duration", true),
    usage: parseUsage(value.usage),
  };
  if (value.responseModel !== undefined) provenance.responseModel = checkedString(value.responseModel, "review response model", 256);
  return provenance;
}

export function createReviewOutcome(job: Pick<ReviewJob, "id" | "digest">, result: ReviewOutcomeResult): ReviewOutcome {
  const completedAt = result.completedAt ?? new Date().toISOString();
  const raw = result.status === "completed"
    ? {
      version: REVIEW_PROTOCOL_VERSION,
      jobId: job.id,
      jobDigest: job.digest,
      status: "completed",
      completedAt,
      operations: result.operations,
      provenance: result.provenance,
    }
    : {
      version: REVIEW_PROTOCOL_VERSION,
      jobId: job.id,
      jobDigest: job.digest,
      status: "failed",
      completedAt,
      error: {
        ...result.error,
        message: sanitizeReviewText(result.error.message),
      },
      ...(result.provenance ? { provenance: result.provenance } : {}),
    };
  return parseReviewOutcome(raw);
}

export function parseReviewOutcome(value: unknown): ReviewOutcome {
  if (!isRecord(value) || value.version !== REVIEW_PROTOCOL_VERSION) throw new Error("Invalid review outcome.");
  const common = {
    version: REVIEW_PROTOCOL_VERSION,
    jobId: checkedString(value.jobId, "review outcome job id", 47, JOB_ID),
    jobDigest: checkedString(value.jobDigest, "review outcome job digest", 64, DIGEST),
    completedAt: checkedIso(value.completedAt, "review completion timestamp"),
  } as const;
  let outcome: ReviewOutcome;
  if (value.status === "completed") {
    exactKeys(value, ["version", "jobId", "jobDigest", "status", "completedAt", "operations", "provenance"]);
    if (!Array.isArray(value.operations) || value.operations.length > 4) throw new Error("Invalid review outcome operations.");
    const provenance = parseProvenance(value.provenance);
    if (provenance.completedAt !== common.completedAt) throw new Error("Review outcome and model completion timestamps differ.");
    outcome = { ...common, status: "completed", operations: value.operations.map(parseOperation), provenance };
  } else if (value.status === "failed") {
    exactKeys(value, ["version", "jobId", "jobDigest", "status", "completedAt", "error"], ["provenance"]);
    const provenance = value.provenance === undefined ? undefined : parseProvenance(value.provenance);
    outcome = { ...common, status: "failed", error: parseFailure(value.error), ...(provenance ? { provenance } : {}) };
  } else {
    throw new Error("Invalid review outcome status.");
  }
  boundedJson(outcome as unknown as Json, MAX_REVIEW_OUTCOME_BYTES, "Review outcome");
  return outcome;
}

export function encodeReviewOutcome(outcome: ReviewOutcome): string {
  return boundedJson(parseReviewOutcome(outcome) as unknown as Json, MAX_REVIEW_OUTCOME_BYTES, "Review outcome");
}

export function decodeReviewOutcome(input: string | Uint8Array): ReviewOutcome {
  return parseReviewOutcome(parseBoundedJson(input, MAX_REVIEW_OUTCOME_BYTES, "Review outcome"));
}
