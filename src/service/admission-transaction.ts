import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  parseReviewJob,
  parseReviewOutcome,
  type ReviewJob,
  type ReviewOutcome,
} from "./protocol.ts";

export const MAX_ADMISSION_INTENT_BYTES = 512 * 1024;
export const DEFAULT_ADMISSION_ARTIFACT_BYTES = 256 * 1024;

const DIGEST = /^[0-9a-f]{64}$/u;
const JOB_ID = /^review_[0-9a-f]{40}$/u;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export type CompletedReviewOutcome = Extract<ReviewOutcome, { status: "completed" }>;
export type AdmissionArtifactState = "missing" | "matching" | "conflicting";
export type AdmissionPhase = "branch" | "revision" | "receipt" | "complete";

export interface AdmissionPreparedArtifacts {
  baseBranchDigest: string;
  resultingBranchDigest: string;
  /** Plain JSON objects; named domain interfaces need not declare an index signature. */
  afterBranch: object;
  revision: object | null;
  receipt: object;
}

export interface AdmissionIntent {
  readonly version: 1;
  readonly kind: "memory-admission";
  readonly transactionId: string;
  readonly proposalDigest: string;
  readonly job: ReviewJob;
  readonly outcome: CompletedReviewOutcome;
  readonly baseBranchDigest: string;
  readonly resultingBranchDigest: string;
  readonly afterBranch: JsonObject;
  readonly revision: JsonObject | null;
  readonly receipt: JsonObject;
  readonly intentDigest: string;
}

export interface AdmissionPublicationCallbacks {
  inspect(intent: AdmissionIntent): Promise<AdmissionArtifactState>;
  apply(intent: AdmissionIntent): Promise<void>;
}

export interface AdmissionRecoveryCallbacks {
  branch: AdmissionPublicationCallbacks;
  revision?: AdmissionPublicationCallbacks;
  receipt: AdmissionPublicationCallbacks;
}

export interface AdmissionRecoveryState {
  readonly intent: AdmissionIntent;
  readonly phase: AdmissionPhase;
  readonly branch: Exclude<AdmissionArtifactState, "conflicting">;
  readonly revision: Exclude<AdmissionArtifactState, "conflicting">;
  readonly receipt: Exclude<AdmissionArtifactState, "conflicting">;
}

export type PrepareAdmission = (
  job: ReviewJob,
  outcome: CompletedReviewOutcome,
) => Promise<AdmissionPreparedArtifacts>;

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value);
  const allowed = new Set(expected);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key)) || actual.some((key) => !allowed.has(key))) {
    throw new Error("Invalid admission intent object shape.");
  }
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`Invalid ${label} digest.`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Admission JSON contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) throw new Error("Admission JSON contains undefined.");
      return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
    }).join(",")}}`;
  }
  throw new Error(`Admission value is not JSON (${typeof value}).`);
}

/** SHA-256 over canonical JSON with recursively sorted object keys. */
export function admissionJsonDigest(value: JsonValue | object): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new Error(`Invalid admission ${label}.`);
  return JSON.parse(canonicalJson(value)) as JsonObject;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function intentCore(intent: Omit<AdmissionIntent, "intentDigest">): Omit<AdmissionIntent, "intentDigest"> {
  return intent;
}

function assertArtifactBindings(intent: Omit<AdmissionIntent, "intentDigest">): void {
  if (intent.baseBranchDigest !== intent.job.baseBranchDigest) {
    throw new Error("Admission intent base digest does not match its review job.");
  }
  if (admissionJsonDigest(intent.afterBranch) !== intent.resultingBranchDigest) {
    throw new Error("Admission intent result digest does not match its frozen branch.");
  }
  if (intent.afterBranch.name !== intent.job.branch.name || intent.afterBranch.version !== intent.job.branch.version) {
    throw new Error("Admission intent branch does not match its review job.");
  }
  if (intent.revision !== null && (
    intent.revision.branchName !== intent.job.branch.name
    || intent.revision.beforeDigest !== intent.baseBranchDigest
    || intent.revision.afterDigest !== intent.resultingBranchDigest
  )) {
    throw new Error("Admission revision is not bound to the intended branch transition.");
  }
  if (
    intent.receipt.proposalId !== intent.job.id
    || intent.receipt.jobDigest !== intent.job.digest
    || intent.receipt.projectKey !== intent.job.projectKey
    || intent.receipt.branchName !== intent.job.branch.name
    || intent.receipt.baseBranchDigest !== intent.baseBranchDigest
    || intent.receipt.resultingBranchDigest !== intent.resultingBranchDigest
  ) {
    throw new Error("Admission receipt is not bound to the intended proposal.");
  }
}

/** Strictly validates every intent field and all digest/identity bindings. */
export function parseAdmissionIntent(value: unknown): AdmissionIntent {
  if (!isRecord(value)) throw new Error("Invalid admission intent.");
  exactKeys(value, [
    "version", "kind", "transactionId", "proposalDigest", "job", "outcome", "baseBranchDigest",
    "resultingBranchDigest", "afterBranch", "revision", "receipt", "intentDigest",
  ]);
  if (value.version !== 1 || value.kind !== "memory-admission") throw new Error("Unsupported admission intent.");
  const job = parseReviewJob(value.job);
  const outcome = parseReviewOutcome(value.outcome);
  if (outcome.status !== "completed" || outcome.jobId !== job.id || outcome.jobDigest !== job.digest) {
    throw new Error("Admission intent requires a matching completed review outcome.");
  }
  if (value.transactionId !== job.id) throw new Error("Admission transaction ID does not match its review job.");
  const proposalDigest = requireDigest(value.proposalDigest, "admission proposal");
  if (proposalDigest !== admissionJsonDigest(outcome as unknown as object)) {
    throw new Error("Admission proposal digest does not match its completed outcome.");
  }
  const core: Omit<AdmissionIntent, "intentDigest"> = {
    version: 1,
    kind: "memory-admission",
    transactionId: job.id,
    proposalDigest,
    job,
    outcome,
    baseBranchDigest: requireDigest(value.baseBranchDigest, "admission base branch"),
    resultingBranchDigest: requireDigest(value.resultingBranchDigest, "admission resulting branch"),
    afterBranch: jsonObject(value.afterBranch, "after-branch"),
    revision: value.revision === null ? null : jsonObject(value.revision, "revision"),
    receipt: jsonObject(value.receipt, "receipt"),
  };
  assertArtifactBindings(core);
  const digest = requireDigest(value.intentDigest, "admission intent");
  if (digest !== admissionJsonDigest(core as unknown as object)) throw new Error("Admission intent digest does not match its contents.");
  return deepFreeze({ ...core, intentDigest: digest });
}

function buildIntent(job: ReviewJob, outcome: CompletedReviewOutcome, prepared: AdmissionPreparedArtifacts): AdmissionIntent {
  const core: Omit<AdmissionIntent, "intentDigest"> = {
    version: 1,
    kind: "memory-admission",
    transactionId: job.id,
    proposalDigest: admissionJsonDigest(outcome as unknown as object),
    job,
    outcome,
    baseBranchDigest: prepared.baseBranchDigest,
    resultingBranchDigest: prepared.resultingBranchDigest,
    afterBranch: jsonObject(prepared.afterBranch, "after-branch"),
    revision: prepared.revision === null ? null : jsonObject(prepared.revision, "revision"),
    receipt: jsonObject(prepared.receipt, "receipt"),
  };
  return parseAdmissionIntent({ ...core, intentDigest: admissionJsonDigest(intentCore(core) as unknown as object) });
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const directoryOnly = "O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0;
  const directory = await open(path, constants.O_RDONLY | noFollow | directoryOnly);
  try {
    if (!(await directory.stat()).isDirectory()) throw new Error(`Admission state path is not a directory: ${path}`);
    await directory.chmod(0o700);
  } finally {
    await directory.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY).catch(() => undefined);
  if (!directory) return;
  try {
    await directory.sync().catch(() => undefined);
  } finally {
    await directory.close().catch(() => undefined);
  }
}

async function readBoundedPrivateJson(path: string, maxBytes: number): Promise<unknown> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const file = await open(path, constants.O_RDONLY | noFollow);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`Admission publication is not a regular file: ${path}`);
    if ((info.mode & 0o777) !== 0o600) throw new Error(`Admission publication must be a private 0600 file: ${path}`);
    if (info.size <= 0 || info.size > maxBytes) throw new Error(`Admission publication exceeds ${maxBytes} bytes or is empty: ${path}`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) throw new Error(`Admission publication exceeds ${maxBytes} bytes: ${path}`);
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`Admission publication exceeds ${maxBytes} bytes: ${path}`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
  } finally {
    await file.close();
  }
}

/** Atomically creates a private JSON artifact, or proves the existing artifact is exactly equal. */
export async function createOrCompareJsonFile(
  path: string,
  value: JsonValue | object,
  maxBytes = DEFAULT_ADMISSION_ARTIFACT_BYTES,
): Promise<"created" | "matching"> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Admission publication byte limit must be positive.");
  const canonical = canonicalJson(value);
  const content = `${canonical}\n`;
  if (Buffer.byteLength(content, "utf8") > maxBytes) throw new Error(`Admission publication exceeds ${maxBytes} bytes.`);
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  let temporaryExists = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    temporaryExists = true;
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
      await unlink(temporary);
      temporaryExists = false;
      await syncDirectory(parent);
      return "created";
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const existing = await readBoundedPrivateJson(path, maxBytes);
      if (canonicalJson(existing) !== canonical) throw new Error(`Conflicting publication already exists at ${path}.`);
      return "matching";
    }
  } finally {
    if (temporaryExists) await unlink(temporary).catch(() => undefined);
  }
}

/** Project-local WAL coordinator. Store-specific branch/revision logic stays behind callbacks. */
export class AdmissionTransactionStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async begin(jobValue: ReviewJob, outcomeValue: ReviewOutcome, prepare: PrepareAdmission): Promise<AdmissionIntent> {
    const job = parseReviewJob(jobValue);
    const parsedOutcome = parseReviewOutcome(outcomeValue);
    if (parsedOutcome.status !== "completed" || parsedOutcome.jobId !== job.id || parsedOutcome.jobDigest !== job.digest) {
      throw new Error("Only a matching completed review outcome can begin admission.");
    }
    await ensurePrivateDirectory(this.root);
    const directory = this.transactionDirectory(job.id);
    await ensurePrivateDirectory(directory);
    const existing = await this.readIfExists(job.id);
    if (existing) return this.compareRequest(existing, job, parsedOutcome);

    const intent = buildIntent(job, parsedOutcome, await prepare(job, parsedOutcome));
    try {
      await createOrCompareJsonFile(this.intentPath(job.id), intent, MAX_ADMISSION_INTENT_BYTES);
      return intent;
    } catch (error) {
      const raced = await this.readIfExists(job.id);
      if (raced) return this.compareRequest(raced, job, parsedOutcome);
      throw error;
    }
  }

  async load(transactionId: string): Promise<AdmissionIntent> {
    this.validateTransactionId(transactionId);
    return parseAdmissionIntent(await readBoundedPrivateJson(this.intentPath(transactionId), MAX_ADMISSION_INTENT_BYTES));
  }

  async inspect(intentValue: AdmissionIntent, callbacks: AdmissionRecoveryCallbacks): Promise<AdmissionRecoveryState> {
    const intent = parseAdmissionIntent(intentValue);
    const branch = await this.inspectStep("branch", callbacks.branch, intent);
    const revision = intent.revision === null
      ? "matching"
      : await this.inspectStep("revision", this.requiredRevision(callbacks), intent);
    const receipt = await this.inspectStep("receipt", callbacks.receipt, intent);
    const orderedStates = intent.revision === null
      ? [{ phase: "branch" as const, state: branch }, { phase: "receipt" as const, state: receipt }]
      : [
          { phase: "branch" as const, state: branch },
          { phase: "revision" as const, state: revision },
          { phase: "receipt" as const, state: receipt },
        ];
    const firstMissing = orderedStates.findIndex((item) => item.state === "missing");
    if (firstMissing >= 0 && orderedStates.slice(firstMissing + 1).some((item) => item.state === "matching")) {
      throw new Error("Admission publications are out of order; recovery fails closed.");
    }
    const phase: AdmissionPhase = firstMissing < 0 ? "complete" : orderedStates[firstMissing]!.phase;
    return deepFreeze({ intent, phase, branch, revision, receipt });
  }

  async recover(intentValue: AdmissionIntent, callbacks: AdmissionRecoveryCallbacks): Promise<AdmissionRecoveryState> {
    const intent = parseAdmissionIntent(intentValue);
    for (let step = 0; step < 4; step += 1) {
      const state = await this.inspect(intent, callbacks);
      if (state.phase === "complete") return state;
      const callback = state.phase === "revision" ? this.requiredRevision(callbacks) : callbacks[state.phase];
      await callback.apply(intent);
    }
    throw new Error("Admission recovery did not reach a durable complete state.");
  }

  private async readIfExists(transactionId: string): Promise<AdmissionIntent | undefined> {
    try {
      return await this.load(transactionId);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private compareRequest(intent: AdmissionIntent, job: ReviewJob, outcome: CompletedReviewOutcome): AdmissionIntent {
    if (
      intent.job.digest !== job.digest
      || canonicalJson(intent.job) !== canonicalJson(job)
      || intent.proposalDigest !== admissionJsonDigest(outcome as unknown as object)
      || canonicalJson(intent.outcome) !== canonicalJson(outcome)
    ) {
      throw new Error(`Conflicting admission intent already exists for ${job.id}.`);
    }
    return intent;
  }

  private async inspectStep(
    name: Exclude<AdmissionPhase, "complete">,
    callback: AdmissionPublicationCallbacks,
    intent: AdmissionIntent,
  ): Promise<Exclude<AdmissionArtifactState, "conflicting">> {
    const state = await callback.inspect(intent);
    if (state === "conflicting") throw new Error(`Conflicting ${name} publication; admission recovery fails closed.`);
    if (state !== "missing" && state !== "matching") throw new Error(`Invalid ${name} admission inspection state.`);
    return state;
  }

  private requiredRevision(callbacks: AdmissionRecoveryCallbacks): AdmissionPublicationCallbacks {
    if (!callbacks.revision) throw new Error("Admission revision callbacks are required for this intent.");
    return callbacks.revision;
  }

  private transactionDirectory(transactionId: string): string {
    this.validateTransactionId(transactionId);
    return join(this.root, transactionId);
  }

  private intentPath(transactionId: string): string {
    return join(this.transactionDirectory(transactionId), "intent.json");
  }

  private validateTransactionId(transactionId: string): void {
    if (!JOB_ID.test(transactionId)) throw new Error("Invalid admission transaction ID.");
  }
}
