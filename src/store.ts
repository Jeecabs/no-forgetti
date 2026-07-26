import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, opendir, readdir, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { atomicCreateFile, atomicWriteFile } from "./atomic-file.ts";
import { memoryCharCount } from "./context.ts";
import { withFileLock } from "./file-lock.ts";
import { projectKey } from "./project.ts";
import { validateMemoryText } from "./security.ts";
import { isErrno, isRecord, optionalIsoTimestamp, requireNonnegativeInteger } from "./state-validation.ts";
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_ENTRY_CHARS,
  MAIN_MEMORY,
  STORE_FILE_BYTE_LIMIT,
  STORE_VERSION,
  type MemoryBranch,
  type MemoryDigest,
  type MemoryEntry,
  type MemoryImportance,
  type MemoryOperation,
  type MemoryWriteOrigin,
  type MutationResult,
  type ProjectMetadata,
  type ReviewAdmissionMetadata,
  type ReviewAdmissionRequest,
  type ReviewAdmissionResult,
  type ReviewAdmissionStatus,
  type ReviewClaim,
  type ReviewOperation,
  type ReviewState,
} from "./types.ts";

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
const REVIEW_LEASE_MS = 5 * 60_000;
const REVIEW_RETRY_BASE_MS = 5 * 60_000;
const REVIEW_RETRY_MAX_MS = 60 * 60_000;
const BRANCH_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;
const ENTRY_ID = /^[a-zA-Z0-9_-]{1,128}$/u;
const MEMORY_IMPORTANCES: readonly unknown[] = ["high", "normal", "low"];
const EXISTING_REVIEW_ACTIONS = new Set(["remove", "replace", "merge", "assess"]);
const DIGEST = /^[a-f0-9]{64}$/u;
const REVISION_ID = /^[a-f0-9-]{36}$/u;
const REVISION_FILE = /^(\d{12})-([a-f0-9-]{36})\.json$/u;
const ADMISSION_TRANSACTION_ID = /^[a-zA-Z0-9_-]{1,128}$/u;
const ADMISSION_INTENT_FILE = /^([a-zA-Z0-9_-]{1,128})\.intent\.json$/u;
const DEFAULT_ADMISSION_SCAN_LIMIT = 256;

type AdmissionFailpoint = "intent-written" | "branch-written" | "revision-written";

interface StoreOptions {
  storageRoot?: string;
  maxChars?: number;
  maxEntryChars?: number;
  now?: () => Date;
  /** Test hook for simulating a process exit at durable admission boundaries. */
  admissionFailpoint?: (phase: AdmissionFailpoint, transactionId: string) => void | Promise<void>;
  /** Bounds work and retained full intents encountered during admission recovery. */
  admissionScanLimit?: number;
}

interface MutationRequest {
  branch: MemoryBranch;
  operation: MemoryOperation;
  sourceSessionId?: string;
  writeOrigin?: MemoryWriteOrigin;
  enforceCapacity?: boolean;
}

interface ReviewMutationRequest {
  branch: MemoryBranch;
  operation: ReviewOperation;
  sourceSessionId?: string;
  writeOrigin: MemoryWriteOrigin;
}

interface AddedRevisionChange {
  kind: "add";
  entryId: string;
  afterDigest: MemoryDigest;
}

interface RemovedRevisionChange {
  kind: "remove";
  entryId: string;
  before: MemoryEntry;
  beforeIndex: number;
}

interface UpdatedRevisionChange {
  kind: "update";
  entryId: string;
  before: MemoryEntry;
  afterDigest: MemoryDigest;
}

type RevisionChange = AddedRevisionChange | RemovedRevisionChange | UpdatedRevisionChange;

interface ReviewRevision {
  version: number;
  kind: "review";
  sequence: number;
  id: string;
  branchName: string;
  committedAt: string;
  beforeDigest: MemoryDigest;
  afterDigest: MemoryDigest;
  changes: RevisionChange[];
}

interface UndoRevision {
  version: number;
  kind: "undo";
  sequence: number;
  id: string;
  branchName: string;
  committedAt: string;
  reviewRevisionId: string;
  beforeDigest: MemoryDigest;
  afterDigest: MemoryDigest;
}

type RevisionRecord = ReviewRevision | UndoRevision;

interface FrozenAdmissionRevision {
  filename: string;
  content: string;
  record: ReviewRevision;
}

interface ReviewAdmissionIntent {
  version: number;
  kind: "review-admission";
  transactionId: string;
  requestDigest: MemoryDigest;
  bindingDigest?: MemoryDigest;
  branchName: string;
  expectedBranchDigest: MemoryDigest;
  status: ReviewAdmissionStatus;
  committedAt: string;
  resultingBranchDigest: MemoryDigest;
  messages: string[];
  afterBranch: MemoryBranch;
  revision?: FrozenAdmissionRevision;
  intentDigest: MemoryDigest;
}

interface AdmissionCompletion {
  version: number;
  kind: "review-admission-complete";
  transactionId: string;
  intentDigest: MemoryDigest;
}

interface ReviewAdmissionTombstone extends ReviewAdmissionMetadata {
  version: number;
  kind: "review-admission-retired";
  originalIntentDigest: MemoryDigest;
  retiredAt: string;
  tombstoneDigest: MemoryDigest;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot digest a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    const fields = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${fields.join(",")}}`;
  }
  throw new Error(`Cannot digest unsupported value type '${typeof value}'.`);
}

function exactDigest(value: unknown): MemoryDigest {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** SHA-256 over every persisted memory-entry field using canonical key ordering. */
export function memoryEntryDigest(entry: MemoryEntry): MemoryDigest {
  return exactDigest(entry);
}

/** SHA-256 over every persisted branch field and ordered entry. */
export function memoryBranchDigest(branch: MemoryBranch): MemoryDigest {
  return exactDigest(branch);
}

function requireDigest(value: unknown, label: string): MemoryDigest {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`Invalid ${label} digest.`);
  return value;
}

function parseImportance(value: unknown, fallback?: MemoryImportance): MemoryImportance | undefined {
  if (value === undefined) return fallback;
  if (MEMORY_IMPORTANCES.includes(value)) return value as MemoryImportance;
  throw new Error("Invalid memory importance.");
}

function requireImportance(value: unknown): MemoryImportance {
  const importance = parseImportance(value);
  if (!importance) throw new Error("Memory review operation requires importance.");
  return importance;
}

function validMergeEntryCount(count: number): boolean {
  return count >= 2 && count <= 8;
}

function parseMemoryEntry(value: unknown): MemoryEntry {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.text !== "string") {
    throw new Error("Invalid memory entry on disk.");
  }
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;
  const createdBy = value.createdBy === "assistant_tool" || value.createdBy === "background_review" ? value.createdBy : undefined;
  const updatedBy = value.updatedBy === "assistant_tool" || value.updatedBy === "background_review" ? value.updatedBy : undefined;
  const importanceAssessedAt = optionalIsoTimestamp(value.importanceAssessedAt, "memory importance assessment timestamp");
  return {
    id: value.id,
    text: value.text,
    createdAt,
    updatedAt,
    ...(typeof value.sourceSessionId === "string" ? { sourceSessionId: value.sourceSessionId } : {}),
    ...(createdBy ? { createdBy } : {}),
    ...(updatedBy ? { updatedBy } : {}),
    importance: parseImportance(value.importance, "normal")!,
    ...(importanceAssessedAt ? { importanceAssessedAt } : {}),
  };
}

function parseMemoryBranch(value: unknown, expectedName: string): MemoryBranch {
  if (!isRecord(value) || !Array.isArray(value.entries)) throw new Error(`Invalid memory branch '${expectedName}' on disk.`);
  if (value.version !== STORE_VERSION) throw new Error(`Unsupported memory branch version for '${expectedName}'.`);
  const name = typeof value.name === "string" ? value.name : expectedName;
  if (name !== expectedName) throw new Error(`Memory branch file mismatch: expected '${expectedName}', found '${name}'.`);
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
  return {
    version: STORE_VERSION,
    name,
    ...(typeof value.parent === "string" ? { parent: value.parent } : {}),
    createdAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
    entries: value.entries.map(parseMemoryEntry),
  };
}

function consolidatedEntries(
  entries: MemoryEntry[],
  mergeIndexes: Set<number>,
  primaryIndex: number,
  replacement: MemoryEntry,
): MemoryEntry[] {
  return entries.flatMap((entry, index) => {
    if (index === primaryIndex) return [replacement];
    return mergeIndexes.has(index) ? [] : [entry];
  });
}

function assertNoDuplicateOutside(entries: MemoryEntry[], excludedIndexes: Set<number>, text: string): void {
  if (entries.some((entry, index) => !excludedIndexes.has(index) && entry.text === text)) {
    throw new Error("Replacement would duplicate another memory entry.");
  }
}

function emptyReviewState(): ReviewState {
  return { version: STORE_VERSION, turnsSinceReview: 0, signalScore: 0, consecutiveFailures: 0, generation: 0 };
}

function parseReviewClaim(value: unknown, expectedBranchName: string): ReviewClaim {
  if (
    !isRecord(value)
    || value.branchName !== expectedBranchName
    || typeof value.token !== "string"
    || !REVISION_ID.test(value.token)
  ) {
    throw new Error("Invalid memory review claim.");
  }
  const generation = requireNonnegativeInteger(value.generation, "memory review claim generation");
  if (generation === 0) throw new Error("Invalid memory review claim generation.");
  return {
    branchName: expectedBranchName,
    generation,
    token: value.token,
    capturedTurns: requireNonnegativeInteger(value.capturedTurns, "memory review claimed turn count"),
    capturedSignalScore: requireNonnegativeInteger(value.capturedSignalScore, "memory review claimed signal score"),
  };
}

function parseReviewState(value: unknown, expectedBranchName: string): ReviewState {
  if (!isRecord(value)) throw new Error("Invalid memory review state.");
  if (value.version !== STORE_VERSION) throw new Error("Unsupported memory review state version.");
  const generation = value.generation === undefined
    ? 0
    : requireNonnegativeInteger(value.generation, "memory review generation");
  const activeClaim = value.activeClaim === undefined
    ? undefined
    : parseReviewClaim(value.activeClaim, expectedBranchName);
  if (activeClaim && activeClaim.generation !== generation) {
    throw new Error("Memory review claim generation mismatch.");
  }
  return {
    version: STORE_VERSION,
    turnsSinceReview: requireNonnegativeInteger(value.turnsSinceReview, "memory review turn count"),
    signalScore: requireNonnegativeInteger(value.signalScore, "memory review signal score"),
    consecutiveFailures: requireNonnegativeInteger(value.consecutiveFailures, "memory review failure count"),
    generation,
    ...(activeClaim ? { activeClaim } : {}),
    lastReviewedAt: optionalIsoTimestamp(value.lastReviewedAt, "memory review timestamp"),
    lastAttemptAt: optionalIsoTimestamp(value.lastAttemptAt, "memory review attempt timestamp"),
    nextAttemptAt: optionalIsoTimestamp(value.nextAttemptAt, "memory review retry timestamp"),
    inFlightUntil: optionalIsoTimestamp(value.inFlightUntil, "memory review lease timestamp"),
  };
}

function parseRevisionChange(value: unknown): RevisionChange {
  if (!isRecord(value) || typeof value.entryId !== "string" || !ENTRY_ID.test(value.entryId)) {
    throw new Error("Invalid memory revision change.");
  }
  if (value.kind === "add") {
    return { kind: "add", entryId: value.entryId, afterDigest: requireDigest(value.afterDigest, "memory revision entry") };
  }
  if (value.kind === "remove") {
    const before = parseMemoryEntry(value.before);
    if (before.id !== value.entryId) throw new Error("Memory revision entry ID mismatch.");
    return {
      kind: "remove",
      entryId: value.entryId,
      before,
      beforeIndex: requireNonnegativeInteger(value.beforeIndex, "memory revision entry index"),
    };
  }
  if (value.kind === "update") {
    const before = parseMemoryEntry(value.before);
    if (before.id !== value.entryId) throw new Error("Memory revision entry ID mismatch.");
    return {
      kind: "update",
      entryId: value.entryId,
      before,
      afterDigest: requireDigest(value.afterDigest, "memory revision entry"),
    };
  }
  throw new Error("Invalid memory revision change kind.");
}

function parseRevisionRecord(
  value: unknown,
  expectedBranchName: string,
  expectedSequence: number,
  expectedId: string,
): RevisionRecord {
  if (!isRecord(value) || value.version !== STORE_VERSION) throw new Error("Invalid or unsupported memory revision.");
  if (
    value.sequence !== expectedSequence
    || value.id !== expectedId
    || value.branchName !== expectedBranchName
    || !REVISION_ID.test(expectedId)
  ) {
    throw new Error("Memory revision file mismatch.");
  }
  const committedAt = optionalIsoTimestamp(value.committedAt, "memory revision timestamp");
  if (!committedAt) throw new Error("Memory revision requires a commit timestamp.");
  const common = {
    version: STORE_VERSION,
    sequence: expectedSequence,
    id: expectedId,
    branchName: expectedBranchName,
    committedAt,
    beforeDigest: requireDigest(value.beforeDigest, "memory revision before-branch"),
    afterDigest: requireDigest(value.afterDigest, "memory revision after-branch"),
  };
  if (value.kind === "review") {
    if (!Array.isArray(value.changes) || value.changes.length === 0 || value.changes.length > 32) {
      throw new Error("Invalid memory review revision changes.");
    }
    const changes = value.changes.map(parseRevisionChange);
    if (new Set(changes.map((change) => change.entryId)).size !== changes.length) {
      throw new Error("Memory review revision contains duplicate entry changes.");
    }
    return { ...common, kind: "review", changes };
  }
  if (value.kind === "undo") {
    if (typeof value.reviewRevisionId !== "string" || !REVISION_ID.test(value.reviewRevisionId)) {
      throw new Error("Invalid memory undo revision target.");
    }
    return { ...common, kind: "undo", reviewRevisionId: value.reviewRevisionId };
  }
  throw new Error("Invalid memory revision kind.");
}

function parseReviewAdmissionIntent(value: unknown): ReviewAdmissionIntent {
  if (!isRecord(value) || value.version !== STORE_VERSION || value.kind !== "review-admission") {
    throw new Error("Invalid or unsupported memory review admission intent.");
  }
  if (typeof value.transactionId !== "string" || !ADMISSION_TRANSACTION_ID.test(value.transactionId)) {
    throw new Error("Invalid memory review admission transaction ID.");
  }
  if (typeof value.branchName !== "string" || !BRANCH_NAME.test(value.branchName)) {
    throw new Error("Invalid memory review admission branch name.");
  }
  const status = value.status;
  if (status !== "applied" && status !== "noop" && status !== "stale" && status !== "rejected") {
    throw new Error("Invalid memory review admission status.");
  }
  const committedAt = optionalIsoTimestamp(value.committedAt, "memory review admission timestamp");
  if (!committedAt) throw new Error("Memory review admission requires a commit timestamp.");
  if (!Array.isArray(value.messages) || value.messages.some((message) => typeof message !== "string")) {
    throw new Error("Invalid memory review admission messages.");
  }
  const afterBranch = parseMemoryBranch(value.afterBranch, value.branchName);
  const resultingBranchDigest = requireDigest(value.resultingBranchDigest, "memory review admission resulting branch");
  if (memoryBranchDigest(afterBranch) !== resultingBranchDigest) {
    throw new Error("Memory review admission resulting branch digest mismatch.");
  }
  let revision: FrozenAdmissionRevision | undefined;
  if (value.revision !== undefined) {
    if (
      !isRecord(value.revision)
      || typeof value.revision.filename !== "string"
      || typeof value.revision.content !== "string"
    ) {
      throw new Error("Invalid memory review admission revision.");
    }
    const match = REVISION_FILE.exec(value.revision.filename);
    if (!match) throw new Error("Invalid memory review admission revision filename.");
    if (value.revision.content !== `${JSON.stringify(value.revision.record, null, 2)}\n`) {
      throw new Error("Memory review admission revision content mismatch.");
    }
    const sequence = Number(match[1]);
    const id = match[2]!;
    const record = parseRevisionRecord(value.revision.record, value.branchName, sequence, id);
    if (record.kind !== "review") throw new Error("Memory review admission requires a review revision.");
    revision = { filename: value.revision.filename, content: value.revision.content, record };
  }
  if ((status === "applied") !== Boolean(revision)) {
    throw new Error("Memory review admission status and revision mismatch.");
  }
  const expectedBranchDigest = requireDigest(value.expectedBranchDigest, "memory review admission expected branch");
  if (revision && (
    revision.record.beforeDigest !== expectedBranchDigest
    || revision.record.afterDigest !== resultingBranchDigest
    || revision.record.committedAt !== committedAt
  )) {
    throw new Error("Memory review admission revision binding mismatch.");
  }
  const core: Omit<ReviewAdmissionIntent, "intentDigest"> = {
    version: STORE_VERSION,
    kind: "review-admission",
    transactionId: value.transactionId,
    requestDigest: requireDigest(value.requestDigest, "memory review admission request"),
    ...(value.bindingDigest === undefined
      ? {}
      : { bindingDigest: requireDigest(value.bindingDigest, "memory review admission binding") }),
    branchName: value.branchName,
    expectedBranchDigest,
    status,
    committedAt,
    resultingBranchDigest,
    messages: [...value.messages] as string[],
    afterBranch,
    ...(revision ? { revision } : {}),
  };
  const intentDigest = requireDigest(value.intentDigest, "memory review admission intent");
  if (intentDigest !== exactDigest(core)) throw new Error("Memory review admission intent digest mismatch.");
  return { ...core, intentDigest };
}

function parseReviewAdmissionTombstone(value: unknown): ReviewAdmissionTombstone {
  if (
    !isRecord(value)
    || value.version !== STORE_VERSION
    || value.kind !== "review-admission-retired"
    || typeof value.transactionId !== "string"
    || !ADMISSION_TRANSACTION_ID.test(value.transactionId)
    || typeof value.branchName !== "string"
    || !BRANCH_NAME.test(value.branchName)
  ) {
    throw new Error("Invalid or unsupported retired memory review admission.");
  }
  const status = value.status;
  if (status !== "applied" && status !== "noop" && status !== "stale" && status !== "rejected") {
    throw new Error("Invalid retired memory review admission status.");
  }
  const committedAt = optionalIsoTimestamp(value.committedAt, "retired memory review admission timestamp");
  const retiredAt = optionalIsoTimestamp(value.retiredAt, "memory review admission retirement timestamp");
  if (!committedAt || !retiredAt) throw new Error("Retired memory review admission requires timestamps.");
  if (!Array.isArray(value.messages) || value.messages.some((message) => typeof message !== "string")) {
    throw new Error("Invalid retired memory review admission messages.");
  }
  const revisionId = value.revisionId === undefined ? undefined : value.revisionId;
  if (revisionId !== undefined && (typeof revisionId !== "string" || !REVISION_ID.test(revisionId))) {
    throw new Error("Invalid retired memory review admission revision ID.");
  }
  if ((status === "applied") !== Boolean(revisionId)) {
    throw new Error("Retired memory review admission status and revision mismatch.");
  }
  const core: Omit<ReviewAdmissionTombstone, "tombstoneDigest"> = {
    version: STORE_VERSION,
    kind: "review-admission-retired",
    transactionId: value.transactionId,
    requestDigest: requireDigest(value.requestDigest, "retired memory review admission request"),
    ...(value.bindingDigest === undefined
      ? {}
      : { bindingDigest: requireDigest(value.bindingDigest, "retired memory review admission binding") }),
    branchName: value.branchName,
    expectedBranchDigest: requireDigest(value.expectedBranchDigest, "retired memory review admission expected branch"),
    status,
    committedAt,
    resultingBranchDigest: requireDigest(value.resultingBranchDigest, "retired memory review admission resulting branch"),
    messages: [...value.messages] as string[],
    ...(revisionId ? { revisionId } : {}),
    originalIntentDigest: requireDigest(value.originalIntentDigest, "retired memory review admission intent"),
    retiredAt,
  };
  const tombstoneDigest = requireDigest(value.tombstoneDigest, "retired memory review admission tombstone");
  if (tombstoneDigest !== exactDigest(core)) throw new Error("Retired memory review admission tombstone digest mismatch.");
  return { ...core, tombstoneDigest };
}

function parseAdmissionCompletion(value: unknown, intent: ReviewAdmissionIntent): AdmissionCompletion {
  if (
    !isRecord(value)
    || value.version !== STORE_VERSION
    || value.kind !== "review-admission-complete"
    || value.transactionId !== intent.transactionId
    || value.intentDigest !== intent.intentDigest
  ) {
    throw new Error("Invalid or conflicting memory review admission completion.");
  }
  return {
    version: STORE_VERSION,
    kind: "review-admission-complete",
    transactionId: intent.transactionId,
    intentDigest: intent.intentDigest,
  };
}

function revisionChanges(before: MemoryBranch, after: MemoryBranch): RevisionChange[] {
  const beforeById = new Map(before.entries.map((entry, index) => [entry.id, { entry, index }]));
  const afterById = new Map(after.entries.map((entry) => [entry.id, entry]));
  const changes: RevisionChange[] = [];
  for (const [entryId, previous] of beforeById) {
    const current = afterById.get(entryId);
    if (!current) {
      changes.push({ kind: "remove", entryId, before: { ...previous.entry }, beforeIndex: previous.index });
    } else if (memoryEntryDigest(previous.entry) !== memoryEntryDigest(current)) {
      changes.push({ kind: "update", entryId, before: { ...previous.entry }, afterDigest: memoryEntryDigest(current) });
    }
  }
  for (const entry of after.entries) {
    if (!beforeById.has(entry.id)) changes.push({ kind: "add", entryId: entry.id, afterDigest: memoryEntryDigest(entry) });
  }
  return changes;
}

function positiveIntegerLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function defaultStorageRoot(): string {
  return getAgentDir();
}

export function projectStorageDir(projectRoot: string, storageRoot = defaultStorageRoot()): string {
  return join(storageRoot, "no-forgetti", projectKey(projectRoot));
}

export class ProjectMemoryStore {
  readonly projectRoot: string;
  readonly projectKey: string;
  readonly projectDir: string;
  readonly maxChars: number;
  readonly maxEntryChars: number;

  private readonly branchesDir: string;
  private readonly reviewsDir: string;
  private readonly revisionsDir: string;
  private readonly admissionsDir: string;
  private readonly retiredAdmissionsDir: string;
  private readonly metadataPath: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly admissionFailpoint?: StoreOptions["admissionFailpoint"];
  private readonly admissionScanLimit: number;

  constructor(projectRoot: string, options: StoreOptions = {}) {
    this.projectRoot = projectRoot;
    this.projectKey = projectKey(projectRoot);
    this.projectDir = projectStorageDir(projectRoot, options.storageRoot);
    this.branchesDir = join(this.projectDir, "branches");
    this.reviewsDir = join(this.projectDir, "reviews");
    this.revisionsDir = join(this.projectDir, "revisions");
    this.admissionsDir = join(this.projectDir, "review-admissions");
    this.retiredAdmissionsDir = join(this.admissionsDir, "retired");
    this.metadataPath = join(this.projectDir, "project.json");
    this.lockPath = join(this.projectDir, ".lock");
    this.maxChars = Math.min(DEFAULT_MAX_CHARS, positiveIntegerLimit(options.maxChars ?? DEFAULT_MAX_CHARS, "Memory character limit"));
    this.maxEntryChars = positiveIntegerLimit(options.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS, "Memory entry character limit");
    this.now = options.now ?? (() => new Date());
    this.admissionFailpoint = options.admissionFailpoint;
    this.admissionScanLimit = positiveIntegerLimit(
      options.admissionScanLimit ?? DEFAULT_ADMISSION_SCAN_LIMIT,
      "Memory admission scan limit",
    );
  }

  async initialize(): Promise<void> {
    await mkdir(this.projectDir, { recursive: true, mode: 0o700 });
    await mkdir(this.branchesDir, { recursive: true, mode: 0o700 });
    await mkdir(this.reviewsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.revisionsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.admissionsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.retiredAdmissionsDir, { recursive: true, mode: 0o700 });
    await this.withLock(async () => {
      const timestamp = this.timestamp();
      const metadata = await this.readJsonIfExists(this.metadataPath);
      if (metadata === undefined) {
        const initial: ProjectMetadata = {
          version: STORE_VERSION,
          projectRoot: this.projectRoot,
          projectKey: this.projectKey,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await this.atomicWrite(this.metadataPath, initial);
      } else if (
        !isRecord(metadata)
        || metadata.version !== STORE_VERSION
        || metadata.projectRoot !== this.projectRoot
        || metadata.projectKey !== this.projectKey
      ) {
        throw new Error(`Project memory metadata mismatch or unsupported version at ${this.metadataPath}.`);
      }

      const mainPath = this.branchPath(MAIN_MEMORY);
      const main = await this.readJsonIfExists(mainPath);
      if (main === undefined) await this.atomicWrite(mainPath, this.emptyBranch(MAIN_MEMORY));
      else this.assertLoadedBranch(parseMemoryBranch(main, MAIN_MEMORY));

      const reviewPath = this.reviewPath(MAIN_MEMORY);
      const review = await this.readJsonIfExists(reviewPath);
      if (review === undefined) {
        await this.atomicWrite(reviewPath, emptyReviewState());
      } else {
        parseReviewState(review, MAIN_MEMORY);
      }

      // Memory reviews now apply atomically. Discard obsolete proposals only
      // after validating active state; corrupt stores must remain untouched.
      await rm(join(this.projectDir, "memory-pending"), { recursive: true, force: true });
      await this.recoverPendingAdmissionsLocked();
    });
  }

  validateBranchName(name: string): string {
    const normalized = name.trim().toLowerCase();
    if (!BRANCH_NAME.test(normalized)) {
      throw new Error("Memory branch names must match [a-z][a-z0-9_-]{0,63}.");
    }
    return normalized;
  }

  branchDigest(branch: MemoryBranch): MemoryDigest {
    return memoryBranchDigest(branch);
  }

  entryDigest(entry: MemoryEntry): MemoryDigest {
    return memoryEntryDigest(entry);
  }

  async loadBranch(name: string): Promise<MemoryBranch> {
    const normalized = this.validateBranchName(name);
    return this.withLock(async () => {
      await this.recoverPendingAdmissionsLocked();
      const value = await this.readJson(this.branchPath(normalized));
      const branch = parseMemoryBranch(value, normalized);
      this.assertLoadedBranch(branch);
      return branch;
    });
  }

  async listBranches(): Promise<MemoryBranch[]> {
    const files = await readdir(this.branchesDir, { withFileTypes: true });
    const names = files
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -5))
      .filter((name) => BRANCH_NAME.test(name));
    const branches = await Promise.all(names.map((name) => this.loadBranch(name)));
    return branches.sort((a, b) => a.name.localeCompare(b.name));
  }

  async forkBranch(from: string, target: string): Promise<MemoryBranch> {
    const sourceName = this.validateBranchName(from);
    const targetName = this.validateBranchName(target);
    if (sourceName === targetName) throw new Error("Fork target must differ from source memory branch.");

    return this.withLock(async () => {
      await this.recoverPendingAdmissionsLocked();
      const targetPath = this.branchPath(targetName);
      if (await this.exists(targetPath)) throw new Error(`Memory branch '${targetName}' already exists.`);
      const source = parseMemoryBranch(await this.readJson(this.branchPath(sourceName)), sourceName);
      this.assertLoadedBranch(source);
      const timestamp = this.timestamp();
      const fork: MemoryBranch = {
        version: STORE_VERSION,
        name: targetName,
        parent: sourceName,
        createdAt: timestamp,
        updatedAt: timestamp,
        entries: source.entries.map((entry) => ({ ...entry })),
      };
      await this.atomicWrite(targetPath, fork);
      try {
        await this.atomicWrite(this.reviewPath(targetName), emptyReviewState());
      } catch (error) {
        await unlink(targetPath).catch(() => undefined);
        throw error;
      }
      return fork;
    });
  }

  async applyOperation(
    name: string,
    operation: MemoryOperation,
    sourceSessionId?: string,
    writeOrigin: MemoryWriteOrigin = "assistant_tool",
  ): Promise<MutationResult> {
    const branchName = this.validateBranchName(name);
    return this.withLock(async () => {
      await this.recoverPendingAdmissionsLocked();
      const branch = parseMemoryBranch(await this.readJson(this.branchPath(branchName)), branchName);
      this.assertLoadedBranch(branch);
      const result = this.mutate({ branch, operation, sourceSessionId, writeOrigin });
      if (result.changed) await this.atomicWrite(this.branchPath(branchName), result.branch);
      return result;
    });
  }

  async applyOperations(
    name: string,
    operations: ReviewOperation[],
    sourceSessionId?: string,
    writeOrigin: MemoryWriteOrigin = "background_review",
    expectedBranchDigest?: MemoryDigest,
  ): Promise<MutationResult[]> {
    const branchName = this.validateBranchName(name);
    return this.withLock(async () => {
      await this.recoverPendingAdmissionsLocked();
      const original = parseMemoryBranch(await this.readJson(this.branchPath(branchName)), branchName);
      this.assertLoadedBranch(original);
      if (expectedBranchDigest !== undefined) {
        const expected = requireDigest(expectedBranchDigest, "expected memory branch");
        const actual = memoryBranchDigest(original);
        if (expected !== actual) {
          return [{
            changed: false,
            message: `Review batch rejected; memory unchanged. Stale memory snapshot (${expected} != ${actual}).`,
            branch: original,
          }];
        }
      }

      let branch = original;
      const results: MutationResult[] = [];
      let changed = false;
      try {
        for (const operation of operations.slice(0, 4).map((item) => this.normalizeReviewOperation(item))) {
          const result = this.mutateReview({ branch, operation, sourceSessionId, writeOrigin });
          branch = result.branch;
          changed ||= result.changed;
          results.push(result);
        }
        this.assertReviewCapacity(branch);
      } catch (error) {
        return [{
          changed: false,
          message: `Review batch rejected; memory unchanged. ${error instanceof Error ? error.message : String(error)}`,
          branch: original,
        }];
      }
      if (changed) {
        const changes = revisionChanges(original, branch);
        if (changes.length === 0) throw new Error("Changed memory review produced no journal changes.");
        await this.readRevisionRecords(branchName);
        await this.atomicWrite(this.branchPath(branchName), branch);
        await this.appendReviewRevision(branchName, original, branch, changes);
      }
      return results;
    });
  }

  /**
   * Begins or recovers one identity-bound external review admission. Once its
   * project-local intent exists, this method only rolls that frozen state forward.
   */
  async applyReviewAdmission(request: ReviewAdmissionRequest): Promise<ReviewAdmissionResult> {
    const transactionId = this.validateAdmissionTransactionId(request.transactionId);
    const branchName = this.validateBranchName(request.branchName);
    const expectedBranchDigest = requireDigest(request.expectedBranchDigest, "expected memory branch");
    const bindingDigest = request.bindingDigest === undefined
      ? undefined
      : requireDigest(request.bindingDigest, "memory review admission binding");
    if (!Array.isArray(request.operations)) throw new Error("Memory review admission requires operations.");
    const requestDigest = exactDigest({
      transactionId,
      branchName,
      expectedBranchDigest,
      ...(bindingDigest ? { bindingDigest } : {}),
      operations: request.operations,
      ...(request.sourceSessionId ? { sourceSessionId: request.sourceSessionId } : {}),
    });

    return this.withLock(async () => {
      const retired = await this.readAdmissionTombstoneIfExists(transactionId);
      if (retired) {
        if (retired.requestDigest !== requestDigest) {
          throw new Error(`Conflicting memory review admission transaction '${transactionId}'.`);
        }
        throw new Error(`Memory review admission transaction '${transactionId}' was safely retired.`);
      }
      const existing = await this.readAdmissionIntentIfExists(transactionId);
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          throw new Error(`Conflicting memory review admission transaction '${transactionId}'.`);
        }
        return this.recoverAdmissionLocked(existing);
      }

      await this.recoverPendingAdmissionsLocked();
      const original = parseMemoryBranch(await this.readJson(this.branchPath(branchName)), branchName);
      this.assertLoadedBranch(original);
      const actualDigest = memoryBranchDigest(original);
      let afterBranch = original;
      let status: ReviewAdmissionStatus;
      let messages: string[];
      let changed = false;

      if (actualDigest !== expectedBranchDigest) {
        status = "stale";
        messages = [`Review batch rejected; memory unchanged. Stale memory snapshot (${expectedBranchDigest} != ${actualDigest}).`];
      } else {
        const results: MutationResult[] = [];
        try {
          for (const operation of request.operations.slice(0, 4).map((item) => this.normalizeReviewOperation(item))) {
            const result = this.mutateReview({
              branch: afterBranch,
              operation,
              sourceSessionId: request.sourceSessionId,
              writeOrigin: "background_review",
            });
            afterBranch = result.branch;
            changed ||= result.changed;
            results.push(result);
          }
          this.assertReviewCapacity(afterBranch);
          status = changed ? "applied" : "noop";
          messages = results.map((result) => result.message);
        } catch (error) {
          afterBranch = original;
          status = "rejected";
          messages = [`Review batch rejected; memory unchanged. ${error instanceof Error ? error.message : String(error)}`];
        }
      }

      this.assertLoadedBranch(afterBranch);
      const committedAt = this.timestamp();
      const resultingBranchDigest = memoryBranchDigest(afterBranch);
      let revision: FrozenAdmissionRevision | undefined;
      if (status === "applied") {
        const changes = revisionChanges(original, afterBranch);
        if (changes.length === 0) throw new Error("Changed memory review produced no journal changes.");
        const next = await this.nextRevision(branchName);
        const filename = `${String(next.sequence).padStart(12, "0")}-${next.id}.json`;
        const record: ReviewRevision = {
          version: STORE_VERSION,
          kind: "review",
          sequence: next.sequence,
          id: next.id,
          branchName,
          committedAt,
          beforeDigest: expectedBranchDigest,
          afterDigest: resultingBranchDigest,
          changes,
        };
        revision = {
          filename,
          content: `${JSON.stringify(record, null, 2)}\n`,
          record,
        };
      }
      const core: Omit<ReviewAdmissionIntent, "intentDigest"> = {
        version: STORE_VERSION,
        kind: "review-admission",
        transactionId,
        requestDigest,
        ...(bindingDigest ? { bindingDigest } : {}),
        branchName,
        expectedBranchDigest,
        status,
        committedAt,
        resultingBranchDigest,
        messages,
        afterBranch,
        ...(revision ? { revision } : {}),
      };
      const intent: ReviewAdmissionIntent = { ...core, intentDigest: exactDigest(core) };
      await this.writeNewJson(this.admissionIntentPath(transactionId), intent);
      await this.runAdmissionFailpoint("intent-written", transactionId);
      return this.recoverAdmissionLocked(intent);
    });
  }

  /** Returns a completed stable result, rolling a begun transaction forward first. */
  async getReviewAdmissionResult(transactionIdValue: string): Promise<ReviewAdmissionResult | undefined> {
    const transactionId = this.validateAdmissionTransactionId(transactionIdValue);
    return this.withLock(async () => {
      const intent = await this.readAdmissionIntentIfExists(transactionId);
      if (!intent) return undefined;
      return this.recoverAdmissionLocked(intent);
    });
  }

  /** Returns immutable receipt-recovery metadata from either a full intent or tombstone. */
  async getReviewAdmissionMetadata(
    transactionIdValue: string,
    bindingDigestValue?: MemoryDigest,
  ): Promise<ReviewAdmissionMetadata | undefined> {
    const transactionId = this.validateAdmissionTransactionId(transactionIdValue);
    const bindingDigest = bindingDigestValue === undefined
      ? undefined
      : requireDigest(bindingDigestValue, "memory review admission binding");
    return this.withLock(async () => {
      const retired = await this.readAdmissionTombstoneIfExists(transactionId);
      if (retired) {
        this.assertAdmissionBinding(retired, bindingDigest);
        return this.admissionMetadata(retired);
      }
      const intent = await this.readAdmissionIntentIfExists(transactionId);
      if (!intent) return undefined;
      this.assertAdmissionBinding(intent, bindingDigest);
      return this.admissionMetadata(await this.recoverAdmissionLocked(intent));
    });
  }

  /**
   * Replaces a completed full intent with an immutable small tombstone. Caller
   * supplies the receipt-safe binding only after its outcome and receipt are durable.
   */
  async retireReviewAdmission(transactionIdValue: string, bindingDigestValue: MemoryDigest): Promise<boolean> {
    const transactionId = this.validateAdmissionTransactionId(transactionIdValue);
    const bindingDigest = requireDigest(bindingDigestValue, "memory review admission retirement binding");
    return this.withLock(async () => {
      const retired = await this.readAdmissionTombstoneIfExists(transactionId);
      if (retired) {
        this.assertAdmissionBinding(retired, bindingDigest);
        await unlink(this.admissionIntentPath(transactionId)).catch((error: unknown) => {
          if (!isErrno(error, "ENOENT")) throw error;
        });
        await unlink(this.admissionCompletionPath(transactionId)).catch((error: unknown) => {
          if (!isErrno(error, "ENOENT")) throw error;
        });
        return false;
      }
      const intent = await this.readAdmissionIntentIfExists(transactionId);
      if (!intent) return false;
      this.assertAdmissionBinding(intent, bindingDigest);
      const result = await this.recoverAdmissionLocked(intent);
      const core: Omit<ReviewAdmissionTombstone, "tombstoneDigest"> = {
        version: STORE_VERSION,
        kind: "review-admission-retired",
        ...this.admissionMetadata(result),
        originalIntentDigest: intent.intentDigest,
        retiredAt: this.timestamp(),
      };
      const tombstone: ReviewAdmissionTombstone = { ...core, tombstoneDigest: exactDigest(core) };
      await this.writeNewJsonOrCompare(
        this.admissionTombstonePath(transactionId),
        tombstone,
        "retired memory review admission tombstone",
      );
      await unlink(this.admissionIntentPath(transactionId));
      await unlink(this.admissionCompletionPath(transactionId));
      return true;
    });
  }

  async undoReview(name: string): Promise<MutationResult> {
    const branchName = this.validateBranchName(name);
    return this.withLock(async () => {
      await this.recoverPendingAdmissionsLocked();
      const records = await this.readRevisionRecords(branchName);
      const undone = new Set(records.filter((record): record is UndoRevision => record.kind === "undo")
        .map((record) => record.reviewRevisionId));
      const revision = records
        .filter((record): record is ReviewRevision => record.kind === "review" && !undone.has(record.id))
        .at(-1);
      if (!revision) throw new Error(`No automatic memory review is available to undo for '${branchName}'.`);

      const current = parseMemoryBranch(await this.readJson(this.branchPath(branchName)), branchName);
      this.assertLoadedBranch(current);
      const previous = this.inverseReviewRevision(current, revision);
      this.assertLoadedBranch(previous);
      await this.atomicWrite(this.branchPath(branchName), previous);
      await this.appendUndoRevision(branchName, revision.id, current, previous);
      return { changed: true, message: "Last automatic memory review undone.", branch: previous };
    });
  }

  async recordUserTurn(name: string, signalScore = 0): Promise<void> {
    const branchName = this.validateBranchName(name);
    await this.withLock(async () => {
      const path = this.reviewPath(branchName);
      const state = parseReviewState(await this.readJson(path), branchName);
      state.turnsSinceReview += 1;
      state.signalScore += Math.max(0, Math.floor(signalScore));
      await this.atomicWrite(path, state);
    });
  }

  async claimReview(
    name: string,
    interval: number,
    signalThreshold: number,
    force = false,
  ): Promise<ReviewClaim | undefined> {
    const branchName = this.validateBranchName(name);
    return this.withLock(async () => {
      const path = this.reviewPath(branchName);
      const state = parseReviewState(await this.readJson(path), branchName);
      const now = this.now();
      const leaseUntil = state.inFlightUntil ? new Date(state.inFlightUntil) : undefined;
      if (leaseUntil && Number.isFinite(leaseUntil.getTime()) && leaseUntil > now) return undefined;
      const nextAttempt = state.nextAttemptAt ? new Date(state.nextAttemptAt) : undefined;
      if (!force && nextAttempt && Number.isFinite(nextAttempt.getTime()) && nextAttempt > now) return undefined;
      if (!force && state.turnsSinceReview < interval && state.signalScore < signalThreshold) return undefined;
      const generation = (state.generation ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) throw new Error("Memory review generation exhausted.");
      const claim: ReviewClaim = {
        branchName,
        generation,
        token: randomUUID(),
        capturedTurns: state.turnsSinceReview,
        capturedSignalScore: state.signalScore,
      };
      state.generation = generation;
      state.activeClaim = claim;
      state.lastAttemptAt = now.toISOString();
      state.inFlightUntil = new Date(now.getTime() + REVIEW_LEASE_MS).toISOString();
      await this.atomicWrite(path, state);
      return claim;
    });
  }

  async finishReviewClaim(name: string, claim: ReviewClaim, success: boolean): Promise<boolean> {
    const branchName = this.validateBranchName(name);
    const expected = parseReviewClaim(claim, branchName);
    return this.withLock(async () => {
      const path = this.reviewPath(branchName);
      const state = parseReviewState(await this.readJson(path), branchName);
      const active = state.activeClaim;
      if (
        !active
        || active.generation !== expected.generation
        || active.token !== expected.token
        || active.capturedTurns !== expected.capturedTurns
        || active.capturedSignalScore !== expected.capturedSignalScore
      ) {
        return false;
      }

      delete state.activeClaim;
      delete state.inFlightUntil;
      const now = this.now();
      if (success) {
        state.turnsSinceReview = Math.max(0, state.turnsSinceReview - active.capturedTurns);
        state.signalScore = Math.max(0, state.signalScore - active.capturedSignalScore);
        state.consecutiveFailures = 0;
        delete state.nextAttemptAt;
        state.lastReviewedAt = now.toISOString();
      } else {
        state.consecutiveFailures += 1;
        const delay = Math.min(REVIEW_RETRY_MAX_MS, REVIEW_RETRY_BASE_MS * (2 ** (state.consecutiveFailures - 1)));
        state.nextAttemptAt = new Date(now.getTime() + delay).toISOString();
      }
      await this.atomicWrite(path, state);
      return true;
    });
  }

  private normalizeReviewOperation(operation: ReviewOperation): ReviewOperation {
    if (!operation || typeof operation !== "object") throw new Error("Invalid memory review operation.");
    if (operation.action === "add") {
      return {
        action: "add",
        content: validateMemoryText(operation.content, this.maxEntryChars),
        importance: requireImportance(operation.importance),
      };
    }
    if (!EXISTING_REVIEW_ACTIONS.has(operation.action)) throw new Error("Invalid memory review operation action.");
    return this.normalizeExistingReviewOperation(operation as Exclude<ReviewOperation, { action: "add" }>);
  }

  private normalizeExistingReviewOperation(operation: Exclude<ReviewOperation, { action: "add" }>): ReviewOperation {
    if (operation.action === "remove") return { action: "remove", entryId: this.validateEntryId(operation.entryId) };
    if (operation.action === "replace") {
      return {
        action: "replace",
        entryId: this.validateEntryId(operation.entryId),
        content: validateMemoryText(operation.content, this.maxEntryChars),
        importance: requireImportance(operation.importance),
      };
    }
    if (operation.action === "merge") {
      return {
        action: "merge",
        entryIds: this.validateMergeEntryIds(operation.entryIds),
        content: validateMemoryText(operation.content, this.maxEntryChars),
        importance: requireImportance(operation.importance),
      };
    }
    return {
      action: "assess",
      entryId: this.validateEntryId(operation.entryId),
      importance: requireImportance(operation.importance),
    };
  }

  private validateEntryId(value: unknown): string {
    if (typeof value !== "string" || !ENTRY_ID.test(value)) throw new Error("Invalid memory entry ID.");
    return value;
  }

  private validateMergeEntryIds(values: unknown): string[] {
    if (!Array.isArray(values)) throw new Error("Memory review merge requires entry IDs.");
    if (!validMergeEntryCount(values.length)) throw new Error("Memory review merge requires 2-8 entry IDs.");
    const entryIds = values.map((entryId) => this.validateEntryId(entryId));
    if (new Set(entryIds).size !== entryIds.length) throw new Error("Memory review merge entry IDs must be unique.");
    return entryIds;
  }

  private cloneBranch(branch: MemoryBranch): MemoryBranch {
    return { ...branch, entries: branch.entries.map((entry) => ({ ...entry })) };
  }

  private entryIndex(entries: MemoryEntry[], entryId: string): number {
    const index = entries.findIndex((entry) => entry.id === entryId);
    if (index < 0) throw new Error(`No memory entry matches ID '${entryId}'.`);
    return index;
  }

  private mutateReview({ branch, operation, sourceSessionId, writeOrigin }: ReviewMutationRequest): MutationResult {
    if (operation.action === "add") {
      return this.mutate({ branch, operation, sourceSessionId, writeOrigin, enforceCapacity: false });
    }
    return this.mutateExistingReview(branch, operation, writeOrigin);
  }

  private mutateExistingReview(
    branch: MemoryBranch,
    operation: Exclude<ReviewOperation, { action: "add" }>,
    writeOrigin: MemoryWriteOrigin,
  ): MutationResult {
    if (operation.action === "remove") return this.removeReviewedEntry(branch, operation.entryId);
    if (operation.action === "replace") return this.replaceReviewedEntry(branch, operation, writeOrigin);
    if (operation.action === "merge") return this.mergeReviewedEntries(branch, operation, writeOrigin);
    return this.assessReviewedEntry(branch, operation);
  }

  private removeReviewedEntry(branch: MemoryBranch, entryId: string): MutationResult {
    const next = this.cloneBranch(branch);
    next.entries.splice(this.entryIndex(next.entries, entryId), 1);
    next.updatedAt = this.timestamp();
    return { changed: true, message: "Memory removed.", branch: next };
  }

  private replaceReviewedEntry(
    branch: MemoryBranch,
    operation: Extract<ReviewOperation, { action: "replace" }>,
    writeOrigin: MemoryWriteOrigin,
  ): MutationResult {
    const next = this.cloneBranch(branch);
    const index = this.entryIndex(next.entries, operation.entryId);
    const match = next.entries.at(index)!;
    if (next.entries.some((entry, entryIndex) => entryIndex !== index && entry.text === operation.content)) {
      throw new Error("Replacement would duplicate another memory entry.");
    }
    const timestamp = this.timestamp();
    next.entries[index] = {
      ...match,
      text: operation.content,
      updatedAt: timestamp,
      updatedBy: writeOrigin,
      importance: operation.importance,
      importanceAssessedAt: timestamp,
    };
    next.updatedAt = timestamp;
    return { changed: true, message: "Memory replaced.", branch: next };
  }

  private mergeReviewedEntries(
    branch: MemoryBranch,
    operation: Extract<ReviewOperation, { action: "merge" }>,
    writeOrigin: MemoryWriteOrigin,
  ): MutationResult {
    const next = this.cloneBranch(branch);
    const mergeIndexes = operation.entryIds.map((entryId) => this.entryIndex(next.entries, entryId));
    const merged = new Set(mergeIndexes);
    assertNoDuplicateOutside(next.entries, merged, operation.content);
    const primaryIndex = mergeIndexes.at(0)!;
    const primary = next.entries.at(primaryIndex)!;
    const timestamp = this.timestamp();
    next.entries = consolidatedEntries(next.entries, merged, primaryIndex, {
      ...primary,
      text: operation.content,
      updatedAt: timestamp,
      updatedBy: writeOrigin,
      importance: operation.importance,
      importanceAssessedAt: timestamp,
    });
    next.updatedAt = timestamp;
    return { changed: true, message: "Memory entries merged.", branch: next };
  }

  private assessReviewedEntry(
    branch: MemoryBranch,
    operation: Extract<ReviewOperation, { action: "assess" }>,
  ): MutationResult {
    const next = this.cloneBranch(branch);
    const index = this.entryIndex(next.entries, operation.entryId);
    const timestamp = this.timestamp();
    next.entries[index] = {
      ...next.entries.at(index)!,
      importance: operation.importance,
      importanceAssessedAt: timestamp,
    };
    next.updatedAt = timestamp;
    return { changed: true, message: "Memory importance assessed.", branch: next };
  }

  private mutate({
    branch,
    operation,
    sourceSessionId,
    writeOrigin = "assistant_tool",
    enforceCapacity = true,
  }: MutationRequest): MutationResult {
    const next: MemoryBranch = { ...branch, entries: branch.entries.map((entry) => ({ ...entry })) };
    const timestamp = this.timestamp();

    if (operation.action === "add") {
      const text = validateMemoryText(operation.content ?? "", this.maxEntryChars);
      if (next.entries.some((entry) => entry.text === text)) {
        return { changed: false, message: "Memory already exists; no duplicate added.", branch };
      }
      next.entries.push({
        id: randomUUID().slice(0, 12),
        text,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(sourceSessionId ? { sourceSessionId } : {}),
        createdBy: writeOrigin,
        updatedBy: writeOrigin,
        importance: parseImportance(operation.importance, "normal")!,
        ...(operation.importance ? { importanceAssessedAt: timestamp } : {}),
      });
      if (enforceCapacity) this.assertCapacity(next);
      next.updatedAt = timestamp;
      return { changed: true, message: "Memory added.", branch: next };
    }

    const oldText = (operation.oldText ?? "").trim();
    if (!oldText) throw new Error(`oldText is required for '${operation.action}'.`);
    const matches = next.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.text.includes(oldText));
    if (matches.length === 0) throw new Error(`No memory entry uniquely matches '${oldText}'.`);
    if (matches.length > 1) throw new Error(`'${oldText}' matches ${matches.length} entries; use a more specific substring.`);
    const match = matches.at(0)!;

    if (operation.action === "remove") {
      next.entries.splice(match.index, 1);
      next.updatedAt = timestamp;
      return { changed: true, message: "Memory removed.", branch: next };
    }

    const text = validateMemoryText(operation.content ?? "", this.maxEntryChars);
    if (next.entries.some((entry, index) => index !== match.index && entry.text === text)) {
      throw new Error("Replacement would duplicate another memory entry.");
    }
    const importance = parseImportance(operation.importance, match.entry.importance)!;
    next.entries[match.index] = {
      ...match.entry,
      text,
      updatedAt: timestamp,
      updatedBy: writeOrigin,
      importance,
      ...(operation.importance ? { importanceAssessedAt: timestamp } : {}),
    };
    if (enforceCapacity) this.assertCapacity(next);
    next.updatedAt = timestamp;
    return { changed: true, message: "Memory replaced.", branch: next };
  }

  private inverseReviewRevision(current: MemoryBranch, revision: ReviewRevision): MemoryBranch {
    const entries = current.entries.map((entry) => ({ ...entry }));
    const stale = (entryId: string): never => {
      throw new Error(`Cannot undo automatic memory review: entry '${entryId}' changed after the review.`);
    };

    for (const change of revision.changes) {
      const match = entries.find((entry) => entry.id === change.entryId);
      if (change.kind === "remove") {
        if (match) stale(change.entryId);
      } else if (!match || memoryEntryDigest(match) !== change.afterDigest) {
        stale(change.entryId);
      }
    }

    const addedIds = new Set(revision.changes
      .filter((change): change is AddedRevisionChange => change.kind === "add")
      .map((change) => change.entryId));
    let restored = entries.filter((entry) => !addedIds.has(entry.id));
    for (const change of revision.changes) {
      if (change.kind !== "update") continue;
      const index = restored.findIndex((entry) => entry.id === change.entryId);
      if (index < 0) stale(change.entryId);
      restored[index] = { ...change.before };
    }
    const removals = revision.changes
      .filter((change): change is RemovedRevisionChange => change.kind === "remove")
      .sort((a, b) => a.beforeIndex - b.beforeIndex);
    for (const change of removals) {
      restored.splice(Math.min(change.beforeIndex, restored.length), 0, { ...change.before });
    }

    const previous: MemoryBranch = { ...current, updatedAt: this.timestamp(), entries: restored };
    this.assertCapacity(previous);
    return previous;
  }

  private assertReviewCapacity(after: MemoryBranch): void {
    // 3,000 characters is a reviewer prompt target, not a storage invariant.
    this.assertCapacity(after);
  }

  private assertCapacity(branch: MemoryBranch): void {
    const used = memoryCharCount(branch);
    if (used > this.maxChars) {
      throw new Error(`Project memory would exceed ${this.maxChars} characters (${used}/${this.maxChars}). Consolidate or remove entries first.`);
    }
  }

  private assertLoadedBranch(branch: MemoryBranch): void {
    if (branch.entries.length > 200) throw new Error(`Memory branch '${branch.name}' has too many entries on disk.`);
    const entryIds = new Set<string>();
    for (const entry of branch.entries) {
      if (!ENTRY_ID.test(entry.id)) throw new Error(`Memory branch '${branch.name}' contains an invalid entry ID.`);
      if (entryIds.has(entry.id)) throw new Error(`Memory branch '${branch.name}' contains duplicate entry IDs.`);
      entryIds.add(entry.id);
      if (entry.text.length > this.maxEntryChars) {
        throw new Error(`Memory branch '${branch.name}' contains an oversized entry on disk.`);
      }
    }
    if (memoryCharCount(branch) > this.maxChars) {
      throw new Error(`Memory branch '${branch.name}' exceeds the ${this.maxChars}-character on-disk limit.`);
    }
  }

  private emptyBranch(name: string): MemoryBranch {
    const timestamp = this.timestamp();
    return {
      version: STORE_VERSION,
      name,
      createdAt: timestamp,
      updatedAt: timestamp,
      entries: [],
    };
  }

  private validateAdmissionTransactionId(value: unknown): string {
    if (typeof value !== "string" || !ADMISSION_TRANSACTION_ID.test(value)) {
      throw new Error("Invalid memory review admission transaction ID.");
    }
    return value;
  }

  private admissionIntentPath(transactionId: string): string {
    return join(this.admissionsDir, `${transactionId}.intent.json`);
  }

  private admissionCompletionPath(transactionId: string): string {
    return join(this.admissionsDir, `${transactionId}.complete.json`);
  }

  private admissionTombstonePath(transactionId: string): string {
    return join(this.retiredAdmissionsDir, `${transactionId}.json`);
  }

  private async readAdmissionTombstoneIfExists(transactionId: string): Promise<ReviewAdmissionTombstone | undefined> {
    const value = await this.readJsonIfExists(this.admissionTombstonePath(transactionId));
    if (value === undefined) return undefined;
    const tombstone = parseReviewAdmissionTombstone(value);
    if (tombstone.transactionId !== transactionId) throw new Error("Retired memory review admission file mismatch.");
    return tombstone;
  }

  private async readAdmissionIntentIfExists(transactionId: string): Promise<ReviewAdmissionIntent | undefined> {
    const value = await this.readJsonIfExists(this.admissionIntentPath(transactionId));
    if (value === undefined) return undefined;
    const intent = parseReviewAdmissionIntent(value);
    if (intent.transactionId !== transactionId) throw new Error("Memory review admission intent file mismatch.");
    this.assertLoadedBranch(intent.afterBranch);
    return intent;
  }

  private async recoverPendingAdmissionsLocked(): Promise<void> {
    const transactionIds: string[] = [];
    const directoryEntryLimit = Math.min(Number.MAX_SAFE_INTEGER, (this.admissionScanLimit * 2) + 1);
    let scannedEntries = 0;
    const directory = await opendir(this.admissionsDir);
    for await (const entry of directory) {
      scannedEntries += 1;
      if (scannedEntries > directoryEntryLimit) {
        throw new Error(`Memory review admission directory scan exceeds ${directoryEntryLimit} entries.`);
      }
      if (!entry.isFile()) continue;
      const match = ADMISSION_INTENT_FILE.exec(entry.name);
      if (!match) continue;
      transactionIds.push(match[1]!);
      if (transactionIds.length > this.admissionScanLimit) {
        throw new Error(`Memory review admission scan exceeds ${this.admissionScanLimit} full intents.`);
      }
    }
    transactionIds.sort();
    for (const transactionId of transactionIds) {
      const intent = await this.readAdmissionIntentIfExists(transactionId);
      if (!intent) throw new Error("Memory review admission intent disappeared during recovery.");
      await this.recoverAdmissionLocked(intent);
    }
  }

  private async recoverAdmissionLocked(intent: ReviewAdmissionIntent): Promise<ReviewAdmissionResult> {
    const completionValue = await this.readJsonIfExists(this.admissionCompletionPath(intent.transactionId));
    if (completionValue !== undefined) {
      parseAdmissionCompletion(completionValue, intent);
      return this.admissionResult(intent);
    }

    const branch = parseMemoryBranch(await this.readJson(this.branchPath(intent.branchName)), intent.branchName);
    this.assertLoadedBranch(branch);
    const actualDigest = memoryBranchDigest(branch);
    if (actualDigest !== intent.expectedBranchDigest && actualDigest !== intent.resultingBranchDigest) {
      throw new Error(
        `Cannot recover memory review admission '${intent.transactionId}': branch digest is neither its base nor result.`,
      );
    }

    const revisionPath = intent.revision
      ? join(this.revisionDir(intent.branchName), intent.revision.filename)
      : undefined;
    if (
      actualDigest === intent.expectedBranchDigest
      && actualDigest !== intent.resultingBranchDigest
      && revisionPath
      && await this.exists(revisionPath)
    ) {
      throw new Error(`Cannot recover memory review admission '${intent.transactionId}': revision exists before branch publication.`);
    }
    if (actualDigest !== intent.resultingBranchDigest) {
      await this.atomicWrite(this.branchPath(intent.branchName), intent.afterBranch);
      await this.runAdmissionFailpoint("branch-written", intent.transactionId);
    }

    if (intent.revision && revisionPath) {
      const records = await this.readRevisionRecords(intent.branchName);
      const expectedSequence = intent.revision.record.sequence;
      const existing = records.at(expectedSequence - 1);
      if (
        (existing && existing.id !== intent.revision.record.id)
        || (!existing && records.length + 1 !== expectedSequence)
      ) {
        throw new Error(`Cannot recover memory review admission '${intent.transactionId}': revision sequence was claimed.`);
      }
      await this.writeNewTextOrCompare(revisionPath, intent.revision.content, "memory review admission revision");
      await this.runAdmissionFailpoint("revision-written", intent.transactionId);
    }
    const completion: AdmissionCompletion = {
      version: STORE_VERSION,
      kind: "review-admission-complete",
      transactionId: intent.transactionId,
      intentDigest: intent.intentDigest,
    };
    await this.writeNewJsonOrCompare(
      this.admissionCompletionPath(intent.transactionId),
      completion,
      "memory review admission completion",
    );
    return this.admissionResult(intent);
  }

  private admissionMetadata(value: ReviewAdmissionIntent | ReviewAdmissionResult | ReviewAdmissionTombstone): ReviewAdmissionMetadata {
    return {
      transactionId: value.transactionId,
      requestDigest: value.requestDigest,
      ...(value.bindingDigest ? { bindingDigest: value.bindingDigest } : {}),
      branchName: value.branchName,
      expectedBranchDigest: value.expectedBranchDigest,
      status: value.status,
      committedAt: value.committedAt,
      resultingBranchDigest: value.resultingBranchDigest,
      messages: [...value.messages],
      ...("revision" in value && value.revision
        ? { revisionId: value.revision.record.id }
        : "revisionId" in value && value.revisionId
          ? { revisionId: value.revisionId }
          : {}),
    };
  }

  private admissionResult(intent: ReviewAdmissionIntent): ReviewAdmissionResult {
    return {
      ...this.admissionMetadata(intent),
      branch: this.cloneBranch(intent.afterBranch),
    };
  }

  private assertAdmissionBinding(
    value: Pick<ReviewAdmissionMetadata, "transactionId" | "bindingDigest">,
    bindingDigest: MemoryDigest | undefined,
  ): void {
    if (value.bindingDigest !== bindingDigest) {
      throw new Error(`Conflicting memory review admission binding for '${value.transactionId}'.`);
    }
  }

  private async runAdmissionFailpoint(phase: AdmissionFailpoint, transactionId: string): Promise<void> {
    await this.admissionFailpoint?.(phase, transactionId);
  }

  private branchPath(name: string): string {
    return join(this.branchesDir, `${name}.json`);
  }

  private reviewPath(name: string): string {
    return join(this.reviewsDir, `${name}.json`);
  }

  private revisionDir(name: string): string {
    return join(this.revisionsDir, name);
  }

  private async readRevisionRecords(name: string): Promise<RevisionRecord[]> {
    const directory = this.revisionDir(name);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    const files = entries
      .filter((entry) => entry.isFile() && REVISION_FILE.test(entry.name))
      .map((entry) => {
        const match = REVISION_FILE.exec(entry.name)!;
        return { name: entry.name, sequence: Number(match[1]), id: match[2]! };
      })
      .sort((a, b) => a.sequence - b.sequence);
    const records: RevisionRecord[] = [];
    const seenSequences = new Set<number>();
    const reviewIds = new Set<string>();
    const undoneReviewIds = new Set<string>();
    for (const file of files) {
      if (
        !Number.isSafeInteger(file.sequence)
        || file.sequence !== records.length + 1
        || seenSequences.has(file.sequence)
      ) {
        throw new Error("Invalid, missing, or duplicate memory revision sequence.");
      }
      seenSequences.add(file.sequence);
      const record = parseRevisionRecord(await this.readJson(join(directory, file.name)), name, file.sequence, file.id);
      if (record.kind === "review") {
        reviewIds.add(record.id);
      } else {
        if (!reviewIds.has(record.reviewRevisionId) || undoneReviewIds.has(record.reviewRevisionId)) {
          throw new Error("Memory undo revision targets an unavailable review revision.");
        }
        undoneReviewIds.add(record.reviewRevisionId);
      }
      records.push(record);
    }
    return records;
  }

  private async appendReviewRevision(
    name: string,
    before: MemoryBranch,
    after: MemoryBranch,
    changes: RevisionChange[],
  ): Promise<void> {
    const { id, sequence, path } = await this.nextRevision(name);
    const revision: ReviewRevision = {
      version: STORE_VERSION,
      kind: "review",
      sequence,
      id,
      branchName: name,
      committedAt: this.timestamp(),
      beforeDigest: memoryBranchDigest(before),
      afterDigest: memoryBranchDigest(after),
      changes,
    };
    await this.writeNewJson(path, revision);
  }

  private async appendUndoRevision(
    name: string,
    reviewRevisionId: string,
    before: MemoryBranch,
    after: MemoryBranch,
  ): Promise<void> {
    const { id, sequence, path } = await this.nextRevision(name);
    const revision: UndoRevision = {
      version: STORE_VERSION,
      kind: "undo",
      sequence,
      id,
      branchName: name,
      committedAt: this.timestamp(),
      reviewRevisionId,
      beforeDigest: memoryBranchDigest(before),
      afterDigest: memoryBranchDigest(after),
    };
    await this.writeNewJson(path, revision);
  }

  private async nextRevision(name: string): Promise<{ id: string; sequence: number; path: string }> {
    const records = await this.readRevisionRecords(name);
    const sequence = (records.at(-1)?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence) || sequence > 999_999_999_999) throw new Error("Memory revision sequence exhausted.");
    const id = randomUUID();
    const filename = `${String(sequence).padStart(12, "0")}-${id}.json`;
    return { id, sequence, path: join(this.revisionDir(name), filename) };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async readJson(path: string): Promise<unknown> {
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error(`Memory state path is not a regular file: ${path}`);
      if (info.size > STORE_FILE_BYTE_LIMIT) {
        throw new Error(`Memory state file exceeds ${STORE_FILE_BYTE_LIMIT} byte limit before parsing: ${path}`);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const remaining = STORE_FILE_BYTE_LIMIT + 1 - total;
        if (remaining <= 0) {
          throw new Error(`Memory state file exceeds ${STORE_FILE_BYTE_LIMIT} byte limit before parsing: ${path}`);
        }
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > STORE_FILE_BYTE_LIMIT) {
          throw new Error(`Memory state file exceeds ${STORE_FILE_BYTE_LIMIT} byte limit before parsing: ${path}`);
        }
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
    } finally {
      await file.close();
    }
  }

  private async readJsonIfExists(path: string): Promise<unknown | undefined> {
    try {
      return await this.readJson(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async atomicWrite(path: string, value: unknown): Promise<void> {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > STORE_FILE_BYTE_LIMIT) {
      throw new Error(`Memory state file would exceed ${STORE_FILE_BYTE_LIMIT} byte limit: ${path}`);
    }
    await atomicWriteFile(path, content);
  }

  private async writeNewJson(path: string, value: unknown): Promise<void> {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > STORE_FILE_BYTE_LIMIT) {
      throw new Error(`Memory revision would exceed ${STORE_FILE_BYTE_LIMIT} byte limit.`);
    }
    await atomicCreateFile(path, content);
  }

  private async writeNewJsonOrCompare(path: string, value: unknown, label: string): Promise<void> {
    await this.writeNewTextOrCompare(path, `${JSON.stringify(value, null, 2)}\n`, label);
  }

  private async writeNewTextOrCompare(path: string, content: string, label: string): Promise<void> {
    if (Buffer.byteLength(content, "utf8") > STORE_FILE_BYTE_LIMIT) {
      throw new Error(`${label} would exceed ${STORE_FILE_BYTE_LIMIT} byte limit.`);
    }
    try {
      await atomicCreateFile(path, content);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const existing = await this.readText(path);
      if (existing !== content) throw new Error(`Conflicting ${label} already exists at ${path}.`);
    }
  }

  private async readText(path: string): Promise<string> {
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error(`Memory state path is not a regular file: ${path}`);
      if (info.size > STORE_FILE_BYTE_LIMIT) {
        throw new Error(`Memory state file exceeds ${STORE_FILE_BYTE_LIMIT} byte limit before reading: ${path}`);
      }
      return await file.readFile({ encoding: "utf8" });
    } finally {
      await file.close();
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.lockPath, LOCK_TIMEOUT_MS, LOCK_STALE_MS, "project memory", fn);
  }
}
