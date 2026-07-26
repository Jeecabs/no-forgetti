import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { atomicWriteFile } from "../atomic-file.ts";
import { FileReviewBudgetAccount, type ReviewBudgetUsage, type ReviewDaemonEvent } from "./daemon.ts";
import { loadServiceConfig, type ReviewAuthorityMode, type ReviewerProfile } from "./config.ts";

const WORKER_STATUS_VERSION = 1;
const MAX_WORKER_STATUS_BYTES = 16 * 1024;
const WORKER_IDLE_FRESH_MS = 30_000;
const WORKER_ACTIVE_FRESH_MS = 6 * 60_000;

export type ReviewWorkerState = "starting" | "idle" | "working" | "waiting-retry" | "budget-exhausted" | "stopped";

export interface ReviewWorkerStatus {
  version: typeof WORKER_STATUS_VERSION;
  workerId: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  state: ReviewWorkerState;
  jobId?: string;
  attempt?: number;
}

export interface ReviewSpoolCounts {
  queued: number;
  running: number;
  outcomes: number;
  deadLetter: number;
}

export interface ReviewServiceMonitor {
  mode: ReviewAuthorityMode;
  reviewer?: Pick<ReviewerProfile, "provider" | "model" | "reasoningEffort" | "maxCallsPerDay" | "maxTokensPerDay" | "maxCostPerDayUsd">;
  budget: ReviewBudgetUsage;
  spool: ReviewSpoolCounts;
  worker?: ReviewWorkerStatus;
  workerFresh: boolean;
  exhausted: Array<"calls" | "tokens" | "cost">;
  observedAt: string;
}

function validIso(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`Invalid ${label}.`);
  return value;
}

function parseWorkerStatus(value: unknown): ReviewWorkerStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid review worker status.");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["version", "workerId", "pid", "startedAt", "updatedAt", "state", "jobId", "attempt"]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || record.version !== WORKER_STATUS_VERSION) {
    throw new Error("Invalid review worker status.");
  }
  const states: ReviewWorkerState[] = ["starting", "idle", "working", "waiting-retry", "budget-exhausted", "stopped"];
  if (typeof record.workerId !== "string" || record.workerId.length < 1 || record.workerId.length > 128
    || !Number.isSafeInteger(record.pid) || (record.pid as number) < 1
    || typeof record.state !== "string" || !states.includes(record.state as ReviewWorkerState)) {
    throw new Error("Invalid review worker status.");
  }
  if (record.jobId !== undefined && (typeof record.jobId !== "string" || !/^review_[0-9a-f]{40}$/u.test(record.jobId))) {
    throw new Error("Invalid review worker status job.");
  }
  if (record.attempt !== undefined && (!Number.isSafeInteger(record.attempt) || (record.attempt as number) < 1)) {
    throw new Error("Invalid review worker status attempt.");
  }
  return {
    version: WORKER_STATUS_VERSION,
    workerId: record.workerId,
    pid: record.pid as number,
    startedAt: validIso(record.startedAt, "review worker start time"),
    updatedAt: validIso(record.updatedAt, "review worker update time"),
    state: record.state as ReviewWorkerState,
    ...(record.jobId ? { jobId: record.jobId as string } : {}),
    ...(record.attempt ? { attempt: record.attempt as number } : {}),
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
    names = (await readdir(dir)).filter((name) => /^[0-9a-f]{24}\.json$/u.test(name)).slice(0, 256);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const statuses = await Promise.all(names.map((name) => readWorkerStatus(join(dir, name)).catch(() => undefined)));
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
  const budget = await new FileReviewBudgetAccount(join(root, "review-budget.json"), { now: () => now }).snapshot();
  const spoolRoot = join(root, "review-spool");
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
    };
  }

  start(): void {
    this.enqueue({ state: "starting" });
  }

  record(event: ReviewDaemonEvent): void {
    if (event.type === "claimed") this.enqueue({ state: "working", jobId: event.jobId, attempt: event.attempt });
    else if (event.type === "retry") this.enqueue({ state: "waiting-retry", jobId: event.jobId, attempt: event.attempt });
    else if (event.type === "budget_exhausted") this.enqueue({ state: "budget-exhausted" });
    else if (event.type === "completed" || event.type === "failed") this.enqueue({ state: "idle" });
    else if (event.type === "idle" && this.current.state !== "waiting-retry") this.enqueue({ state: "idle" });
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
