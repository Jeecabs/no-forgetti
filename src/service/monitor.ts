import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { atomicWriteFile } from "../atomic-file.ts";
import { exactKeys, isRecord, requireIsoTimestamp } from "../state-validation.ts";
import { DEFAULT_MAX_CHARS, MEMORY_POLICY_VERSION } from "../types.ts";
import { FileReviewAttemptAccounting, type ReviewBudgetAmount } from "./accounting.ts";
import { FileReviewBudgetAccount, type ReviewBudgetUsage, type ReviewDaemonEvent } from "./daemon.ts";
import { loadServiceConfig, type ReviewAuthorityMode, type ReviewerProfile } from "./config.ts";

const WORKER_STATUS_VERSION = 1;
const MAX_WORKER_STATUS_BYTES = 16 * 1024;
const WORKER_IDLE_FRESH_MS = 30_000;
const WORKER_ACTIVE_FRESH_MS = 6 * 60_000;
const MAX_WORKER_STATUS_FILES = 4_096;
const MAX_WORKER_STATUS_READS = 32;

export type ReviewWorkerState = "starting" | "idle" | "working" | "waiting-retry" | "budget-exhausted" | "stopped";

export interface ReviewWorkerStatus {
  version: typeof WORKER_STATUS_VERSION;
  workerId: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  state: ReviewWorkerState;
  memoryPolicyVersion?: number;
  maxMemoryChars?: number;
  jobId?: string;
  attempt?: number;
}

export interface ReviewSpoolCounts {
  queued: number;
  running: number;
  outcomes: number;
  deadLetter: number;
}

export interface ReviewMonitorBudget extends ReviewBudgetUsage {
  charged?: ReviewBudgetAmount;
  held?: ReviewBudgetAmount;
  unknown?: ReviewBudgetAmount;
}

export interface ReviewServiceMonitor {
  mode: ReviewAuthorityMode;
  reviewer?: Pick<ReviewerProfile, "provider" | "model" | "reasoningEffort" | "maxCallsPerDay" | "maxTokensPerDay" | "maxCostPerDayUsd">;
  budget: ReviewMonitorBudget;
  spool: ReviewSpoolCounts;
  worker?: ReviewWorkerStatus;
  workerFresh: boolean;
  /** Undefined when no worker exists; false identifies a legacy/stale-policy worker. */
  workerCompatible?: boolean;
  exhausted: Array<"calls" | "tokens" | "cost">;
  observedAt: string;
}

const WORKER_STATES = new Set<ReviewWorkerState>([
  "starting", "idle", "working", "waiting-retry", "budget-exhausted", "stopped",
]);

function workerId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new Error("Invalid review worker id.");
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`Invalid ${label}.`);
  return value as number;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, label);
}

function workerState(value: unknown): ReviewWorkerState {
  if (typeof value !== "string" || !WORKER_STATES.has(value as ReviewWorkerState)) {
    throw new Error("Invalid review worker state.");
  }
  return value as ReviewWorkerState;
}

function optionalJobId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^review_[0-9a-f]{40}$/u.test(value)) {
    throw new Error("Invalid review worker status job.");
  }
  return value;
}

function definedWorkerFields(fields: {
  memoryPolicyVersion?: number;
  maxMemoryChars?: number;
  jobId?: string;
  attempt?: number;
}): Partial<ReviewWorkerStatus> {
  return Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== undefined));
}

function parseWorkerStatus(value: unknown): ReviewWorkerStatus {
  if (!isRecord(value)) throw new Error("Invalid review worker status.");
  exactKeys(
    value,
    ["version", "workerId", "pid", "startedAt", "updatedAt", "state"],
    ["memoryPolicyVersion", "maxMemoryChars", "jobId", "attempt"],
  );
  if (value.version !== WORKER_STATUS_VERSION) throw new Error("Invalid review worker status version.");
  const memoryPolicyVersion = optionalPositiveInteger(value.memoryPolicyVersion, "review worker memory policy version");
  const maxMemoryChars = optionalPositiveInteger(value.maxMemoryChars, "review worker memory capacity");
  const jobId = optionalJobId(value.jobId);
  const attempt = optionalPositiveInteger(value.attempt, "review worker status attempt");
  return {
    version: WORKER_STATUS_VERSION,
    workerId: workerId(value.workerId),
    pid: positiveInteger(value.pid, "review worker pid"),
    startedAt: requireIsoTimestamp(value.startedAt, "review worker start time"),
    updatedAt: requireIsoTimestamp(value.updatedAt, "review worker update time"),
    state: workerState(value.state),
    ...definedWorkerFields({ memoryPolicyVersion, maxMemoryChars, jobId, attempt }),
  };
}

async function readWorkerStatus(path: string): Promise<ReviewWorkerStatus | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > MAX_WORKER_STATUS_BYTES) throw new Error("Invalid review worker status file.");
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_WORKER_STATUS_BYTES) throw new Error("Review worker status is oversized.");
    return parseWorkerStatus(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function countRecords(path: string): Promise<number> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && !entry.name.endsWith(".tmp")).length;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function exhaustedDimensions(profile: ReviewerProfile | undefined, budget: ReviewBudgetUsage): ReviewServiceMonitor["exhausted"] {
  if (!profile) return [];
  const exhausted: ReviewServiceMonitor["exhausted"] = [];
  if (budget.calls >= profile.maxCallsPerDay) exhausted.push("calls");
  if (budget.tokens >= profile.maxTokensPerDay) exhausted.push("tokens");
  if (budget.costUsd >= profile.maxCostPerDayUsd) exhausted.push("cost");
  return exhausted;
}

export function workerStatusPath(agentDir: string, workerId: string): string {
  const key = createHash("sha256").update(workerId, "utf8").digest("hex").slice(0, 24);
  return join(resolve(agentDir), "no-forgetti", "review-workers", `${key}.json`);
}

async function readWorkerStatuses(agentDir: string): Promise<ReviewWorkerStatus[]> {
  const dir = join(resolve(agentDir), "no-forgetti", "review-workers");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => /^[0-9a-f]{24}\.json$/u.test(name)).slice(0, MAX_WORKER_STATUS_FILES);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  // One status file accumulates per worker identity and a dead worker never
  // rewrites its own, so bound the reads by recency instead of directory order.
  const dated = await Promise.all(names.map(async (name) => {
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    return { path, mtimeMs: info?.mtimeMs ?? 0 };
  }));
  const recent = dated.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, MAX_WORKER_STATUS_READS);
  const statuses = await Promise.all(recent.map(({ path }) => readWorkerStatus(path).catch(() => undefined)));
  return statuses.filter((status): status is ReviewWorkerStatus => Boolean(status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readReviewServiceMonitor(
  agentDir = getAgentDir(),
  now: Date = new Date(),
): Promise<ReviewServiceMonitor> {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid review service monitor clock.");
  const root = join(resolve(agentDir), "no-forgetti");
  const config = await loadServiceConfig(agentDir);
  const spoolRoot = join(root, "review-spool");
  const accountingPath = join(spoolRoot, "accounting");
  const hasAttemptAccounting = Boolean(config.reviewer && await stat(accountingPath).then((info) => info.isDirectory()).catch(() => false));
  const budget: ReviewMonitorBudget = hasAttemptAccounting && config.reviewer
    ? await new FileReviewAttemptAccounting(spoolRoot, { now: () => now }).snapshot(config.reviewer.provider).then((snapshot) => ({
        day: snapshot.day,
        calls: snapshot.effective.calls,
        tokens: snapshot.effective.tokens,
        costUsd: snapshot.effective.costNanodollars / 1_000_000_000,
        charged: snapshot.charged,
        held: snapshot.held,
        unknown: snapshot.unknown,
      }))
    : await new FileReviewBudgetAccount(join(root, "review-budget.json"), { now: () => now }).snapshot();
  const [queued, running, outcomes, deadLetter, workers] = await Promise.all([
    countRecords(join(spoolRoot, "queued")),
    countRecords(join(spoolRoot, "running")),
    countRecords(join(spoolRoot, "outcomes")),
    countRecords(join(spoolRoot, "dead-letter")),
    readWorkerStatuses(agentDir),
  ]);
  const worker = workers.find((candidate) => candidate.state !== "stopped") ?? workers.at(0);
  return {
    mode: config.mode,
    ...(config.reviewer ? { reviewer: { ...config.reviewer } } : {}),
    budget,
    spool: { queued, running, outcomes, deadLetter },
    ...(worker ? { worker } : {}),
    workerFresh: Boolean(worker && worker.state !== "stopped" && now.getTime() - new Date(worker.updatedAt).getTime()
      <= (worker.state === "working" ? WORKER_ACTIVE_FRESH_MS : WORKER_IDLE_FRESH_MS)),
    ...(worker ? {
      workerCompatible: worker.memoryPolicyVersion === MEMORY_POLICY_VERSION
        && worker.maxMemoryChars === DEFAULT_MAX_CHARS,
    } : {}),
    exhausted: exhaustedDimensions(config.reviewer, budget),
    observedAt: now.toISOString(),
  };
}

/** Atomic, serialized worker heartbeat for the in-Pi service monitor. */
export class ReviewWorkerStatusReporter {
  readonly path: string;

  private readonly workerId: string;
  private readonly pid: number;
  private readonly startedAt: string;
  private pending: Promise<void> = Promise.resolve();
  private current: ReviewWorkerStatus;

  constructor(agentDir: string, workerId: string, now: Date = new Date()) {
    if (!workerId || workerId.length > 128 || !Number.isFinite(now.getTime())) throw new Error("Invalid review worker identity.");
    this.path = workerStatusPath(agentDir, workerId);
    this.workerId = workerId;
    this.pid = process.pid;
    this.startedAt = now.toISOString();
    this.current = {
      version: WORKER_STATUS_VERSION,
      workerId,
      pid: this.pid,
      startedAt: this.startedAt,
      updatedAt: this.startedAt,
      state: "starting",
      memoryPolicyVersion: MEMORY_POLICY_VERSION,
      maxMemoryChars: DEFAULT_MAX_CHARS,
    };
  }

  start(): void {
    this.enqueue({ state: "starting" });
  }

  record(event: ReviewDaemonEvent): void {
    if (event.type === "claimed") this.enqueue({ state: "working", jobId: event.jobId, attempt: event.attempt });
    else if (event.type === "retry") this.enqueue({ state: "waiting-retry", jobId: event.jobId, attempt: event.attempt });
    else if (event.type === "budget_exhausted" || event.type === "attempt_budget_exhausted") this.enqueue({
      state: "budget-exhausted",
      ...(event.type === "attempt_budget_exhausted" ? { jobId: event.jobId, attempt: event.attempt } : {}),
    });
    else if (event.type === "completed" || event.type === "failed") this.enqueue({ state: "idle" });
    else if (event.type === "idle" && this.current.state !== "waiting-retry") this.enqueue({ state: "idle" });
  }

  heartbeat(): void {
    this.enqueue({
      state: this.current.state,
      ...(this.current.jobId ? { jobId: this.current.jobId } : {}),
      ...(this.current.attempt ? { attempt: this.current.attempt } : {}),
    });
  }

  stop(): void {
    this.enqueue({ state: "stopped" });
  }

  flush(): Promise<void> {
    return this.pending;
  }

  private enqueue(update: Pick<ReviewWorkerStatus, "state"> & Partial<Pick<ReviewWorkerStatus, "jobId" | "attempt">>): void {
    const updatedAt = new Date().toISOString();
    this.current = {
      version: WORKER_STATUS_VERSION,
      workerId: this.workerId,
      pid: this.pid,
      startedAt: this.startedAt,
      updatedAt,
      state: update.state,
      memoryPolicyVersion: MEMORY_POLICY_VERSION,
      maxMemoryChars: DEFAULT_MAX_CHARS,
      ...(update.jobId ? { jobId: update.jobId } : {}),
      ...(update.attempt ? { attempt: update.attempt } : {}),
    };
    const snapshot = { ...this.current };
    this.pending = this.pending
      .catch(() => undefined)
      .then(async () => {
        await atomicWriteFile(this.path, `${JSON.stringify(snapshot, null, 2)}\n`);
        await chmod(this.path, 0o600);
      })
      .catch(() => undefined);
  }
}
