import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { atomicWriteFile } from "./atomic-file.ts";
import { memoryCharCount } from "./context.ts";
import { withFileLock } from "./file-lock.ts";
import { projectKey } from "./project.ts";
import { validateMemoryText } from "./security.ts";
import { optionalIsoTimestamp, requireNonnegativeInteger } from "./state-validation.ts";
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_ENTRY_CHARS,
  MAIN_MEMORY,
  STORE_VERSION,
  type MemoryBranch,
  type MemoryEntry,
  type MemoryOperation,
  type MemoryReviewProposal,
  type MemoryWriteOrigin,
  type MutationResult,
  type ProjectMetadata,
  type ReviewState,
} from "./types.ts";

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
const REVIEW_LEASE_MS = 5 * 60_000;
const REVIEW_RETRY_BASE_MS = 5 * 60_000;
const REVIEW_RETRY_MAX_MS = 60 * 60_000;
const BRANCH_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;

interface StoreOptions {
  storageRoot?: string;
  maxChars?: number;
  maxEntryChars?: number;
  now?: () => Date;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateMemoryProposalId(id: string): string {
  const normalized = id.trim();
  if (!/^\d{14}-[0-9a-f]{8}$/u.test(normalized)) throw new Error("Invalid memory proposal id.");
  return normalized;
}

function parseMemoryEntry(value: unknown): MemoryEntry {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.text !== "string") {
    throw new Error("Invalid memory entry on disk.");
  }
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;
  const createdBy = value.createdBy === "assistant_tool" || value.createdBy === "background_review" ? value.createdBy : undefined;
  const updatedBy = value.updatedBy === "assistant_tool" || value.updatedBy === "background_review" ? value.updatedBy : undefined;
  return {
    id: value.id,
    text: value.text,
    createdAt,
    updatedAt,
    ...(typeof value.sourceSessionId === "string" ? { sourceSessionId: value.sourceSessionId } : {}),
    ...(createdBy ? { createdBy } : {}),
    ...(updatedBy ? { updatedBy } : {}),
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

function emptyReviewState(): ReviewState {
  return { version: STORE_VERSION, turnsSinceReview: 0, signalScore: 0, consecutiveFailures: 0 };
}

function parseReviewState(value: unknown): ReviewState {
  if (!isRecord(value)) throw new Error("Invalid memory review state.");
  if (value.version !== STORE_VERSION) throw new Error("Unsupported memory review state version.");
  return {
    version: STORE_VERSION,
    turnsSinceReview: requireNonnegativeInteger(value.turnsSinceReview, "memory review turn count"),
    signalScore: requireNonnegativeInteger(value.signalScore, "memory review signal score"),
    consecutiveFailures: requireNonnegativeInteger(value.consecutiveFailures, "memory review failure count"),
    lastReviewedAt: optionalIsoTimestamp(value.lastReviewedAt, "memory review timestamp"),
    lastAttemptAt: optionalIsoTimestamp(value.lastAttemptAt, "memory review attempt timestamp"),
    nextAttemptAt: optionalIsoTimestamp(value.nextAttemptAt, "memory review retry timestamp"),
    inFlightUntil: optionalIsoTimestamp(value.inFlightUntil, "memory review lease timestamp"),
  };
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
  readonly memoryPendingDir: string;
  private readonly revisionsDir: string;
  private readonly metadataPath: string;
  private readonly lockPath: string;
  private readonly now: () => Date;

  constructor(projectRoot: string, options: StoreOptions = {}) {
    this.projectRoot = projectRoot;
    this.projectKey = projectKey(projectRoot);
    this.projectDir = projectStorageDir(projectRoot, options.storageRoot);
    this.branchesDir = join(this.projectDir, "branches");
    this.reviewsDir = join(this.projectDir, "reviews");
    this.revisionsDir = join(this.projectDir, "revisions");
    this.memoryPendingDir = join(this.projectDir, "memory-pending");
    this.metadataPath = join(this.projectDir, "project.json");
    this.lockPath = join(this.projectDir, ".lock");
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.maxEntryChars = options.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS;
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await mkdir(this.projectDir, { recursive: true, mode: 0o700 });
    await mkdir(this.branchesDir, { recursive: true, mode: 0o700 });
    await mkdir(this.reviewsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.revisionsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.memoryPendingDir, { recursive: true, mode: 0o700 });
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
        parseReviewState(review);
      }
    });
  }

  validateBranchName(name: string): string {
    const normalized = name.trim().toLowerCase();
    if (!BRANCH_NAME.test(normalized)) {
      throw new Error("Memory branch names must match [a-z][a-z0-9_-]{0,63}.");
    }
    return normalized;
  }

  async loadBranch(name: string): Promise<MemoryBranch> {
    const normalized = this.validateBranchName(name);
    const value = await this.readJson(this.branchPath(normalized));
    const branch = parseMemoryBranch(value, normalized);
    this.assertLoadedBranch(branch);
    return branch;
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
      const branch = parseMemoryBranch(await this.readJson(this.branchPath(branchName)), branchName);
      this.assertLoadedBranch(branch);
      const result = this.mutate(branch, operation, sourceSessionId, writeOrigin);
      if (result.changed) await this.atomicWrite(this.branchPath(branchName), result.branch);
      return result;
    });
  }

  async applyOperations(
    name: string,
    operations: MemoryOperation[],
    sourceSessionId?: string,
    writeOrigin: MemoryWriteOrigin = "background_review",
  ): Promise<MutationResult[]> {
    const branchName = this.validateBranchName(name);
    return this.withLock(async () => {
      const original = parseMemoryBranch(await this.readJson(this.branchPath(branchName)), branchName);
      this.assertLoadedBranch(original);
      let branch = original;
      const results: MutationResult[] = [];
      let changed = false;
      try {
        for (const operation of operations.slice(0, 4)) {
          const result = this.mutate(branch, operation, sourceSessionId, writeOrigin, false);
          branch = result.branch;
          changed ||= result.changed;
          results.push(result);
        }
        this.assertCapacity(branch);
      } catch (error) {
        return [{
          changed: false,
          message: `Review batch rejected; memory unchanged. ${error instanceof Error ? error.message : String(error)}`,
          branch: original,
        }];
      }
      if (changed) {
        await this.atomicWrite(this.revisionPath(branchName), original);
        await this.atomicWrite(this.branchPath(branchName), branch);
      }
      return results;
    });
  }

  async stageReviewProposal(
    name: string,
    operations: MemoryOperation[],
    sourceSessionId?: string,
  ): Promise<MemoryReviewProposal | undefined> {
    const branchName = this.validateBranchName(name);
    if (operations.length === 0) return undefined;
    return this.withLock(async () => {
      const original = parseMemoryBranch(await this.readJson(this.branchPath(branchName)), branchName);
      this.assertLoadedBranch(original);
      let branch = original;
      const normalized = operations.slice(0, 4).map((operation) => this.normalizeReviewOperation(operation));
      for (const operation of normalized) branch = this.mutate(branch, operation, sourceSessionId, "background_review", false).branch;
      this.assertCapacity(branch);

      const existing = (await this.listPendingReviews()).find((proposal) => (
        proposal.branch === branchName && JSON.stringify(proposal.operations) === JSON.stringify(normalized)
      ));
      if (existing) return existing;
      const proposal: MemoryReviewProposal = {
        version: STORE_VERSION,
        id: `${this.timestamp().replace(/[^0-9]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
        branch: branchName,
        createdAt: this.timestamp(),
        ...(sourceSessionId ? { sourceSessionId } : {}),
        operations: normalized,
      };
      await this.atomicWrite(join(this.memoryPendingDir, `${proposal.id}.json`), proposal);
      return proposal;
    });
  }

  async listPendingReviews(): Promise<MemoryReviewProposal[]> {
    const entries = await readdir(this.memoryPendingDir, { withFileTypes: true });
    const proposals: MemoryReviewProposal[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filenameId = validateMemoryProposalId(entry.name.slice(0, -5));
      const value = await this.readJson(join(this.memoryPendingDir, entry.name));
      if (!isRecord(value) || value.version !== STORE_VERSION || value.id !== filenameId || !Array.isArray(value.operations)) {
        throw new Error("Invalid memory review proposal.");
      }
      proposals.push({
        version: STORE_VERSION,
        id: filenameId,
        branch: this.validateBranchName(String(value.branch ?? "")),
        createdAt: optionalIsoTimestamp(value.createdAt, "memory proposal timestamp") ?? this.timestamp(),
        ...(typeof value.sourceSessionId === "string" ? { sourceSessionId: value.sourceSessionId } : {}),
        operations: value.operations.map((operation) => this.normalizeReviewOperation(operation as MemoryOperation)),
      });
    }
    return proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async approveReviewProposal(id: string): Promise<MutationResult[]> {
    const safeId = validateMemoryProposalId(id);
    const proposal = (await this.listPendingReviews()).find((item) => item.id === safeId);
    if (!proposal) throw new Error(`No pending memory proposal '${safeId}'.`);
    const results = await this.applyOperations(proposal.branch, proposal.operations, proposal.sourceSessionId, "background_review");
    if (!results.some((result) => result.message.startsWith("Review batch rejected;"))) {
      await this.withLock(async () => unlink(join(this.memoryPendingDir, `${safeId}.json`)));
    }
    return results;
  }

  async rejectReviewProposal(id: string): Promise<void> {
    const safeId = validateMemoryProposalId(id);
    await this.withLock(async () => unlink(join(this.memoryPendingDir, `${safeId}.json`)));
  }

  async undoReview(name: string): Promise<MutationResult> {
    const branchName = this.validateBranchName(name);
    return this.withLock(async () => {
      const path = this.revisionPath(branchName);
      if (!await this.exists(path)) throw new Error(`No automatic memory review is available to undo for '${branchName}'.`);
      const previous = parseMemoryBranch(await this.readJson(path), branchName);
      this.assertLoadedBranch(previous);
      await this.atomicWrite(this.branchPath(branchName), previous);
      await unlink(path).catch(() => undefined);
      return { changed: true, message: "Last automatic memory review undone.", branch: previous };
    });
  }

  async recordUserTurn(name: string, signalScore = 0): Promise<void> {
    const branchName = this.validateBranchName(name);
    await this.withLock(async () => {
      const path = this.reviewPath(branchName);
      const state = parseReviewState(await this.readJson(path));
      state.turnsSinceReview += 1;
      state.signalScore += Math.max(0, Math.floor(signalScore));
      await this.atomicWrite(path, state);
    });
  }

  async claimReviewIfDue(name: string, interval: number, signalThreshold: number, force = false): Promise<boolean> {
    const branchName = this.validateBranchName(name);
    return this.withLock(async () => {
      const path = this.reviewPath(branchName);
      const state = parseReviewState(await this.readJson(path));
      const now = this.now();
      const leaseUntil = state.inFlightUntil ? new Date(state.inFlightUntil) : undefined;
      if (leaseUntil && Number.isFinite(leaseUntil.getTime()) && leaseUntil > now) return false;
      const nextAttempt = state.nextAttemptAt ? new Date(state.nextAttemptAt) : undefined;
      if (!force && nextAttempt && Number.isFinite(nextAttempt.getTime()) && nextAttempt > now) return false;
      if (!force && state.turnsSinceReview < interval && state.signalScore < signalThreshold) return false;
      state.lastAttemptAt = now.toISOString();
      state.inFlightUntil = new Date(now.getTime() + REVIEW_LEASE_MS).toISOString();
      await this.atomicWrite(path, state);
      return true;
    });
  }

  async finishReview(name: string, success: boolean): Promise<void> {
    const branchName = this.validateBranchName(name);
    await this.withLock(async () => {
      const path = this.reviewPath(branchName);
      const state = parseReviewState(await this.readJson(path));
      delete state.inFlightUntil;
      if (success) {
        state.turnsSinceReview = 0;
        state.signalScore = 0;
        state.consecutiveFailures = 0;
        delete state.nextAttemptAt;
        state.lastReviewedAt = this.timestamp();
      } else {
        state.consecutiveFailures += 1;
        const delay = Math.min(REVIEW_RETRY_MAX_MS, REVIEW_RETRY_BASE_MS * (2 ** (state.consecutiveFailures - 1)));
        state.nextAttemptAt = new Date(this.now().getTime() + delay).toISOString();
      }
      await this.atomicWrite(path, state);
    });
  }

  private normalizeReviewOperation(operation: MemoryOperation): MemoryOperation {
    if (!operation || typeof operation !== "object") throw new Error("Invalid memory review operation.");
    if (operation.action === "add") {
      return { action: "add", content: validateMemoryText(operation.content ?? "", this.maxEntryChars) };
    }
    if (operation.action === "replace") {
      const oldText = (operation.oldText ?? "").trim();
      if (!oldText || oldText.length > this.maxEntryChars) throw new Error("Invalid memory review replacement match.");
      return { action: "replace", oldText, content: validateMemoryText(operation.content ?? "", this.maxEntryChars) };
    }
    if (operation.action === "remove") {
      const oldText = (operation.oldText ?? "").trim();
      if (!oldText || oldText.length > this.maxEntryChars) throw new Error("Invalid memory review removal match.");
      return { action: "remove", oldText };
    }
    throw new Error("Invalid memory review operation action.");
  }

  private mutate(
    branch: MemoryBranch,
    operation: MemoryOperation,
    sourceSessionId?: string,
    writeOrigin: MemoryWriteOrigin = "assistant_tool",
    enforceCapacity = true,
  ): MutationResult {
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
    const match = matches[0];

    if (operation.action === "remove") {
      next.entries.splice(match.index, 1);
      next.updatedAt = timestamp;
      return { changed: true, message: "Memory removed.", branch: next };
    }

    const text = validateMemoryText(operation.content ?? "", this.maxEntryChars);
    if (next.entries.some((entry, index) => index !== match.index && entry.text === text)) {
      throw new Error("Replacement would duplicate another memory entry.");
    }
    next.entries[match.index] = { ...match.entry, text, updatedAt: timestamp, updatedBy: writeOrigin };
    if (enforceCapacity) this.assertCapacity(next);
    next.updatedAt = timestamp;
    return { changed: true, message: "Memory replaced.", branch: next };
  }

  private assertCapacity(branch: MemoryBranch): void {
    const used = memoryCharCount(branch);
    if (used > this.maxChars) {
      throw new Error(`Project memory would exceed ${this.maxChars} characters (${used}/${this.maxChars}). Consolidate or remove entries first.`);
    }
  }

  private assertLoadedBranch(branch: MemoryBranch): void {
    if (branch.entries.length > 200) throw new Error(`Memory branch '${branch.name}' has too many entries on disk.`);
    for (const entry of branch.entries) {
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

  private branchPath(name: string): string {
    return join(this.branchesDir, `${name}.json`);
  }

  private reviewPath(name: string): string {
    return join(this.reviewsDir, `${name}.json`);
  }

  private revisionPath(name: string): string {
    return join(this.revisionsDir, `${name}.json`);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async readJson(path: string): Promise<unknown> {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
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
    await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
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
