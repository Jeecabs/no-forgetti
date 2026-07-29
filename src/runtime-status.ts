import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { atomicWriteFile } from "./atomic-file.ts";
import { exactKeys, isErrno, isRecord, requireIsoTimestamp } from "./state-validation.ts";

const RUNTIME_STATUS_VERSION = 1 as const;
const MAX_RUNTIME_STATUS_BYTES = 8 * 1_024;
const MAX_RUNTIME_FILES = 4_096;
const RUNTIME_FRESH_MS = 30_000;
const RELEASE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;
const PROJECT_KEY = /^[0-9a-f]{16,64}$/u;

export type RuntimeKind = "extension" | "worker";
export type RuntimeState = "running" | "stopped";

export interface RuntimeStatus {
  version: typeof RUNTIME_STATUS_VERSION;
  runtimeId: string;
  kind: RuntimeKind;
  pid: number;
  releaseVersion: string;
  memoryPolicyVersion: number;
  startedAt: string;
  updatedAt: string;
  state: RuntimeState;
  projectRoot?: string;
  projectKey?: string;
}

export interface RuntimeStatusReporterOptions {
  agentDir: string;
  identity: string;
  kind: RuntimeKind;
  pid?: number;
  releaseVersion: string;
  memoryPolicyVersion: number;
  projectRoot?: string;
  projectKey?: string;
  now?: () => Date;
  heartbeatMs?: number;
}

export interface RuntimeReporter {
  start(): void;
  heartbeat(): void;
  stop(): void;
  flush(): Promise<void>;
}

export interface RuntimeFleet {
  current: RuntimeStatus[];
  mismatched: RuntimeStatus[];
  stale: RuntimeStatus[];
  stopped: RuntimeStatus[];
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`Invalid ${label}.`);
  return value as number;
}

function checkedReleaseVersion(value: unknown): string {
  if (typeof value !== "string" || !RELEASE_VERSION.test(value)) throw new Error("Invalid No Forgetti release version.");
  return value;
}

function checkedProjectRoot(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new Error("Invalid No Forgetti runtime project root.");
  }
  return value;
}

function checkedProjectKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !PROJECT_KEY.test(value)) throw new Error("Invalid No Forgetti runtime project key.");
  return value;
}

function checkedRuntimeId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{24}$/u.test(value)) {
    throw new Error("Invalid No Forgetti runtime ID.");
  }
  return value;
}

function checkedRuntimeKind(value: unknown): RuntimeKind {
  if (value !== "extension" && value !== "worker") throw new Error("Invalid No Forgetti runtime kind.");
  return value;
}

function checkedRuntimeState(value: unknown): RuntimeState {
  if (value !== "running" && value !== "stopped") throw new Error("Invalid No Forgetti runtime state.");
  return value;
}

function parseRuntimeStatus(value: unknown): RuntimeStatus {
  if (!isRecord(value)) throw new Error("Invalid No Forgetti runtime status.");
  exactKeys(
    value,
    ["version", "runtimeId", "kind", "pid", "releaseVersion", "memoryPolicyVersion", "startedAt", "updatedAt", "state"],
    ["projectRoot", "projectKey"],
  );
  if (value.version !== RUNTIME_STATUS_VERSION) throw new Error("Invalid No Forgetti runtime status version.");
  const startedAt = requireIsoTimestamp(value.startedAt, "runtime start time");
  const updatedAt = requireIsoTimestamp(value.updatedAt, "runtime update time");
  if (updatedAt < startedAt) throw new Error("No Forgetti runtime update precedes its start.");
  const projectRoot = checkedProjectRoot(value.projectRoot);
  const projectKey = checkedProjectKey(value.projectKey);
  return {
    version: RUNTIME_STATUS_VERSION,
    runtimeId: checkedRuntimeId(value.runtimeId),
    kind: checkedRuntimeKind(value.kind),
    pid: positiveInteger(value.pid, "No Forgetti runtime pid"),
    releaseVersion: checkedReleaseVersion(value.releaseVersion),
    memoryPolicyVersion: positiveInteger(value.memoryPolicyVersion, "No Forgetti runtime memory policy version"),
    startedAt,
    updatedAt,
    state: checkedRuntimeState(value.state),
    ...(projectRoot ? { projectRoot } : {}),
    ...(projectKey ? { projectKey } : {}),
  };
}

function runtimeId(identity: string): string {
  if (!identity || identity.length > 4_096) throw new Error("Invalid No Forgetti runtime identity.");
  return createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 24);
}

function runtimeDirectory(agentDir: string): string {
  return join(resolve(agentDir), "no-forgetti", "runtimes");
}

function runtimeStatusPath(agentDir: string, identity: string): string {
  return join(runtimeDirectory(agentDir), `${runtimeId(identity)}.json`);
}

async function readRuntimeStatus(path: string): Promise<RuntimeStatus> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > MAX_RUNTIME_STATUS_BYTES) {
      throw new Error("Invalid No Forgetti runtime status file.");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_RUNTIME_STATUS_BYTES) throw new Error("No Forgetti runtime status is oversized.");
    return parseRuntimeStatus(JSON.parse(bytes.toString("utf8")) as unknown);
  } finally {
    await handle.close();
  }
}

type RuntimeFleetBucket = keyof RuntimeFleet;

function runtimeFleetBucket(
  runtime: RuntimeStatus,
  expectedReleaseVersion: string,
  expectedMemoryPolicyVersion: number,
  now: Date,
): RuntimeFleetBucket {
  if (runtime.state === "stopped") return "stopped";
  const age = now.getTime() - new Date(runtime.updatedAt).getTime();
  if (age < 0 || age > RUNTIME_FRESH_MS) return "stale";
  if (runtime.releaseVersion !== expectedReleaseVersion
    || runtime.memoryPolicyVersion !== expectedMemoryPolicyVersion) return "mismatched";
  return "current";
}

export async function readRuntimeFleet(
  agentDir: string,
  options: { expectedReleaseVersion: string; expectedMemoryPolicyVersion: number; now?: Date },
): Promise<RuntimeFleet> {
  const expectedReleaseVersion = checkedReleaseVersion(options.expectedReleaseVersion);
  const expectedMemoryPolicyVersion = positiveInteger(options.expectedMemoryPolicyVersion, "expected memory policy version");
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid No Forgetti runtime fleet clock.");
  let names: string[];
  try {
    names = (await readdir(runtimeDirectory(agentDir)))
      .filter((name) => /^[0-9a-f]{24}\.json$/u.test(name))
      .sort();
  } catch (error) {
    if (isErrno(error, "ENOENT")) names = [];
    else throw error;
  }
  if (names.length > MAX_RUNTIME_FILES) throw new Error("Too many No Forgetti runtime status files.");
  const runtimes = await Promise.all(names.map((name) => readRuntimeStatus(join(runtimeDirectory(agentDir), name))));
  const fleet: RuntimeFleet = { current: [], mismatched: [], stale: [], stopped: [] };
  for (const runtime of runtimes) {
    fleet[runtimeFleetBucket(runtime, expectedReleaseVersion, expectedMemoryPolicyVersion, now)].push(runtime);
  }
  return fleet;
}

export class RuntimeStatusReporter implements RuntimeReporter {
  readonly path: string;

  private readonly runtimeId: string;
  private readonly options: RuntimeStatusReporterOptions;
  private readonly clock: () => Date;
  private readonly startedAt: string;
  private readonly heartbeatMs: number;
  private pending: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private state: RuntimeState = "stopped";

  constructor(options: RuntimeStatusReporterOptions) {
    this.runtimeId = runtimeId(options.identity);
    this.path = runtimeStatusPath(options.agentDir, options.identity);
    this.clock = options.now ?? (() => new Date());
    const started = this.clock();
    if (!Number.isFinite(started.getTime())) throw new Error("Invalid No Forgetti runtime reporter clock.");
    this.startedAt = started.toISOString();
    this.heartbeatMs = positiveInteger(options.heartbeatMs ?? 10_000, "runtime heartbeat interval");
    this.options = {
      ...options,
      pid: positiveInteger(options.pid ?? process.pid, "No Forgetti runtime pid"),
      releaseVersion: checkedReleaseVersion(options.releaseVersion),
      memoryPolicyVersion: positiveInteger(options.memoryPolicyVersion, "No Forgetti runtime memory policy version"),
      ...(options.projectRoot ? { projectRoot: checkedProjectRoot(options.projectRoot) } : {}),
      ...(options.projectKey ? { projectKey: checkedProjectKey(options.projectKey) } : {}),
    };
  }

  start(): void {
    if (this.timer) return;
    this.state = "running";
    this.enqueue();
    this.timer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.timer.unref?.();
  }

  heartbeat(): void {
    if (this.state === "running") this.enqueue();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.state = "stopped";
    this.enqueue();
  }

  flush(): Promise<void> {
    return this.pending;
  }

  private enqueue(): void {
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) return;
    const status: RuntimeStatus = {
      version: RUNTIME_STATUS_VERSION,
      runtimeId: this.runtimeId,
      kind: this.options.kind,
      pid: this.options.pid!,
      releaseVersion: this.options.releaseVersion,
      memoryPolicyVersion: this.options.memoryPolicyVersion,
      startedAt: this.startedAt,
      updatedAt: now.toISOString(),
      state: this.state,
      ...(this.options.projectRoot ? { projectRoot: this.options.projectRoot } : {}),
      ...(this.options.projectKey ? { projectKey: this.options.projectKey } : {}),
    };
    this.pending = this.pending
      .catch(() => undefined)
      .then(async () => {
        await mkdir(runtimeDirectory(this.options.agentDir), { recursive: true, mode: 0o700 });
        await atomicWriteFile(this.path, `${JSON.stringify(status, null, 2)}\n`);
        await chmod(this.path, 0o600);
      });
  }
}
