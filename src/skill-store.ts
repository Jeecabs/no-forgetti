import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { projectStorageDir } from "./store.ts";
import {
  DEFAULT_SKILL_REVIEW_INTERVAL,
  DEFAULT_SKILL_REVIEW_SIGNAL_THRESHOLD,
  MAX_SKILL_CONTENT_CHARS,
  SKILL_STORE_VERSION,
  type ProjectSkill,
  type SkillMutationResult,
  type SkillOperation,
  type SkillProposal,
  type SkillReviewState,
  type SkillWriteOrigin,
} from "./skill-types.ts";
import {
  validateSkillContent,
  validateSkillDescription,
  validateSkillName,
} from "./skill-security.ts";

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
const REVIEW_LEASE_MS = 5 * 60_000;
const REVIEW_RETRY_BASE_MS = 5 * 60_000;
const REVIEW_RETRY_MAX_MS = 60 * 60_000;
const SKILL_FILE = "SKILL.md";
const RETRIEVAL_STOP_WORDS = new Set([
  "a", "an", "and", "are", "do", "for", "how", "i", "in", "is", "it", "my", "of", "on", "or", "project", "the", "to", "use", "what", "when", "with",
]);
const MAX_RETRIEVAL_QUERY_CHARS = 256;
const MAX_RETRIEVAL_TERMS = 32;
const MAX_SKILL_OUTPUT_CHARS = 12_000;
const MAX_SKILL_INDEX_CHARS = 6_000;

function retrievalTerms(value: string): string[] {
  return [...new Set(value.normalize("NFKC").slice(0, MAX_RETRIEVAL_QUERY_CHARS).toLowerCase().match(/[a-z0-9]+/gu) ?? [])]
    .filter((term) => term.length > 2 && !RETRIEVAL_STOP_WORDS.has(term))
    .slice(0, MAX_RETRIEVAL_TERMS);
}

function boundSkillContent(content: string, maxChars = MAX_SKILL_OUTPUT_CHARS): string {
  const limit = Number.isFinite(maxChars) ? Math.min(MAX_SKILL_OUTPUT_CHARS, Math.max(1_000, Math.floor(maxChars))) : MAX_SKILL_OUTPUT_CHARS;
  if (content.length <= limit) return content;
  const marker = "\n\n[TRUNCATED: use the project_skill tool for the full playbook]";
  const bodyLimit = Math.max(1, limit - marker.length);
  const boundary = content.lastIndexOf("\n", bodyLimit);
  return `${content.slice(0, boundary > 0 ? boundary : bodyLimit).trimEnd()}${marker}`;
}

interface SkillStoreOptions {
  storageRoot?: string;
  projectDir?: string;
  now?: () => Date;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emptyReviewState(): SkillReviewState {
  return { version: SKILL_STORE_VERSION, turnsSinceReview: 0, signalScore: 0, consecutiveFailures: 0 };
}

function parseReviewState(value: unknown): SkillReviewState {
  if (!isRecord(value)) return emptyReviewState();
  if (value.version !== SKILL_STORE_VERSION) throw new Error("Unsupported project skill review state.");
  const number = (key: string) => typeof value[key] === "number" && Number.isFinite(value[key])
    ? Math.max(0, Math.floor(value[key] as number))
    : 0;
  return {
    version: SKILL_STORE_VERSION,
    turnsSinceReview: number("turnsSinceReview"),
    signalScore: number("signalScore"),
    consecutiveFailures: number("consecutiveFailures"),
    ...(typeof value.lastReviewedAt === "string" ? { lastReviewedAt: value.lastReviewedAt } : {}),
    ...(typeof value.lastAttemptAt === "string" ? { lastAttemptAt: value.lastAttemptAt } : {}),
    ...(typeof value.nextAttemptAt === "string" ? { nextAttemptAt: value.nextAttemptAt } : {}),
    ...(typeof value.inFlightUntil === "string" ? { inFlightUntil: value.inFlightUntil } : {}),
  };
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

function parseSkillFile(text: string, fallbackName: string, now: string): ProjectSkill {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u);
  if (!match) throw new Error(`Skill '${fallbackName}' is missing frontmatter.`);

  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), parseYamlScalar(line.slice(separator + 1)));
  }
  const name = validateSkillName(fields.get("name") || fallbackName);
  const description = validateSkillDescription(fields.get("description") || "");
  const content = validateSkillContent(match[2]);
  const numberField = (key: string) => {
    const value = Number(fields.get(key) || 0);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  };
  return {
    name,
    description,
    content,
    createdAt: fields.get("createdAt") || now,
    updatedAt: fields.get("updatedAt") || now,
    createdBy: fields.get("createdBy") === "foreground" ? "foreground" : "background_review",
    updatedBy: fields.get("updatedBy") === "foreground" ? "foreground" : "background_review",
    state: "active",
    useCount: 0,
    viewCount: 0,
    patchCount: numberField("patchCount"),
    ...(numberField("useCount") > 0 ? { useCount: numberField("useCount") } : {}),
    ...(numberField("viewCount") > 0 ? { viewCount: numberField("viewCount") } : {}),
    ...(fields.get("lastUsedAt") ? { lastUsedAt: fields.get("lastUsedAt") } : {}),
    ...(fields.get("lastViewedAt") ? { lastViewedAt: fields.get("lastViewedAt") } : {}),
    ...(fields.get("lastPatchedAt") ? { lastPatchedAt: fields.get("lastPatchedAt") } : {}),
  };
}

function renderSkillFile(skill: ProjectSkill): string {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    "version: 0.1.0",
    "author: No Forgetti",
    `createdAt: ${skill.createdAt}`,
    `updatedAt: ${skill.updatedAt}`,
    `createdBy: ${skill.createdBy}`,
    `updatedBy: ${skill.updatedBy}`,
    `useCount: ${skill.useCount}`,
    `viewCount: ${skill.viewCount}`,
    `patchCount: ${skill.patchCount}`,
    ...(skill.lastUsedAt ? [`lastUsedAt: ${skill.lastUsedAt}`] : []),
    ...(skill.lastViewedAt ? [`lastViewedAt: ${skill.lastViewedAt}`] : []),
    ...(skill.lastPatchedAt ? [`lastPatchedAt: ${skill.lastPatchedAt}`] : []),
    "---",
    "",
    skill.content,
    "",
  ].join("\n");
}

export class ProjectSkillStore {
  readonly projectDir: string;
  readonly skillsDir: string;
  readonly archiveDir: string;
  readonly pendingDir: string;
  readonly revisionsDir: string;
  readonly reviewPath: string;

  private readonly lockPath: string;
  private readonly now: () => Date;

  constructor(projectRoot: string, options: SkillStoreOptions = {}) {
    this.projectDir = options.projectDir ?? projectStorageDir(projectRoot, options.storageRoot);
    this.skillsDir = join(this.projectDir, "skills");
    this.archiveDir = join(this.skillsDir, ".archive");
    this.pendingDir = join(this.projectDir, "skill-pending");
    this.revisionsDir = join(this.projectDir, "skill-revisions");
    this.reviewPath = join(this.projectDir, "skill-review.json");
    this.lockPath = join(this.projectDir, ".lock");
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await mkdir(this.projectDir, { recursive: true, mode: 0o700 });
    await mkdir(this.skillsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.archiveDir, { recursive: true, mode: 0o700 });
    await mkdir(this.pendingDir, { recursive: true, mode: 0o700 });
    await mkdir(this.revisionsDir, { recursive: true, mode: 0o700 });
    await this.withLock(async () => {
      if (!await this.exists(this.reviewPath)) await this.atomicWrite(this.reviewPath, emptyReviewState());
      else parseReviewState(await this.readJson(this.reviewPath));
    });
  }

  async listSkills(): Promise<ProjectSkill[]> {
    const entries = await readdir(this.skillsDir, { withFileTypes: true });
    const skills: ProjectSkill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        skills.push(await this.loadSkill(entry.name));
      } catch {
        // Invalid skill packages stay invisible to the model and are surfaced by status later.
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  async loadSkill(name: string): Promise<ProjectSkill> {
    const normalized = validateSkillName(name);
    const path = join(this.skillsDir, normalized, SKILL_FILE);
    const skill = parseSkillFile(await readFile(path, "utf8"), normalized, this.timestamp());
    if (skill.name !== normalized) throw new Error(`Skill package name mismatch: expected '${normalized}'.`);
    return skill;
  }

  async skillIndex(): Promise<string> {
    const skills = await this.listSkills();
    if (skills.length === 0) return "(no project skills have been formed yet)";
    const lines: string[] = [];
    let usedChars = 0;
    for (const skill of skills) {
      const line = `- ${skill.name}: ${skill.description}`;
      if (usedChars + line.length + 1 > MAX_SKILL_INDEX_CHARS) {
        lines.push(`[TRUNCATED: ${skills.length - lines.length} more skills]`);
        break;
      }
      lines.push(line);
      usedChars += line.length + 1;
    }
    return lines.join("\n");
  }

  async findRelevantSkills(query: string, limit = 2): Promise<ProjectSkill[]> {
    const terms = retrievalTerms(query);
    if (terms.length === 0) return [];
    const scored = (await this.listSkills()).map((skill) => {
      const nameTerms = new Set(retrievalTerms(skill.name.replaceAll("-", " ")));
      const descriptionTerms = new Set(retrievalTerms(skill.description));
      const score = terms.reduce((total, term) => total + (nameTerms.has(term) ? 3 : descriptionTerms.has(term) ? 1 : 0), 0);
      return { skill, score };
    });
    const safeLimit = Number.isFinite(limit) ? Math.min(5, Math.max(1, Math.floor(limit))) : 2;
    return scored
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, safeLimit)
      .map(({ skill }) => skill);
  }

  async viewSkill(name: string): Promise<ProjectSkill> {
    const skill = await this.loadSkill(name);
    await this.touchUsage(skill.name, "view");
    return { ...skill, content: boundSkillContent(skill.content) };
  }

  async recordUse(name: string): Promise<void> {
    await this.touchUsage(validateSkillName(name), "use");
  }

  async stageProposal(operations: SkillOperation[], sourceSessionId?: string): Promise<SkillProposal> {
    if (operations.length > 1) throw new Error("A self-forming skill review may stage one operation at a time.");
    const normalized = operations.map((operation) => this.validateOperation(operation));
    const proposal: SkillProposal = {
      version: SKILL_STORE_VERSION,
      id: `${this.timestamp().replace(/[^0-9]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
      createdAt: this.timestamp(),
      ...(sourceSessionId ? { sourceSessionId } : {}),
      operations: normalized,
    };
    await this.withLock(async () => {
      await this.atomicWrite(join(this.pendingDir, `${proposal.id}.json`), proposal);
    });
    return proposal;
  }

  async listPending(): Promise<SkillProposal[]> {
    const entries = await readdir(this.pendingDir, { withFileTypes: true });
    const proposals: SkillProposal[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const value = await this.readJson(join(this.pendingDir, entry.name));
      if (!isRecord(value) || value.version !== SKILL_STORE_VERSION || !Array.isArray(value.operations)) continue;
      proposals.push({
        version: SKILL_STORE_VERSION,
        id: String(value.id || entry.name.slice(0, -5)),
        createdAt: typeof value.createdAt === "string" ? value.createdAt : this.timestamp(),
        ...(typeof value.sourceSessionId === "string" ? { sourceSessionId: value.sourceSessionId } : {}),
        operations: value.operations.map((operation) => this.validateOperation(operation as SkillOperation)),
      });
    }
    return proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async approveProposal(id: string, origin: SkillWriteOrigin = "background_review"): Promise<SkillMutationResult> {
    return this.withLock(async () => {
      const path = join(this.pendingDir, `${id}.json`);
      const proposal = await this.readProposal(path);
      const operation = proposal.operations[0];
      if (!operation) {
        await unlink(path);
        return { changed: false, message: `Skill proposal '${id}' was empty.` };
      }
      const result = await this.applyOperation(operation, origin, id);
      if (result.changed) await unlink(path);
      return result;
    });
  }

  async rejectProposal(id: string): Promise<void> {
    await this.withLock(async () => {
      await unlink(join(this.pendingDir, `${id}.json`));
    });
  }

  async recordUserTurn(signalScore = 0): Promise<void> {
    await this.withLock(async () => {
      const state = parseReviewState(await this.readJson(this.reviewPath));
      state.turnsSinceReview += 1;
      state.signalScore += Math.max(0, Math.floor(signalScore));
      await this.atomicWrite(this.reviewPath, state);
    });
  }

  async claimReviewIfDue(
    interval = DEFAULT_SKILL_REVIEW_INTERVAL,
    signalThreshold = DEFAULT_SKILL_REVIEW_SIGNAL_THRESHOLD,
    force = false,
  ): Promise<boolean> {
    return this.withLock(async () => {
      const state = parseReviewState(await this.readJson(this.reviewPath));
      const now = this.now();
      const lease = state.inFlightUntil ? new Date(state.inFlightUntil) : undefined;
      const next = state.nextAttemptAt ? new Date(state.nextAttemptAt) : undefined;
      if (!force && lease && Number.isFinite(lease.getTime()) && lease > now) return false;
      if (!force && next && Number.isFinite(next.getTime()) && next > now) return false;
      if (!force && state.turnsSinceReview < interval && state.signalScore < signalThreshold) return false;
      state.lastAttemptAt = now.toISOString();
      state.inFlightUntil = new Date(now.getTime() + REVIEW_LEASE_MS).toISOString();
      await this.atomicWrite(this.reviewPath, state);
      return true;
    });
  }

  async finishReview(success: boolean): Promise<void> {
    await this.withLock(async () => {
      const state = parseReviewState(await this.readJson(this.reviewPath));
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
      await this.atomicWrite(this.reviewPath, state);
    });
  }

  private validateOperation(operation: SkillOperation): SkillOperation {
    if (!operation || typeof operation !== "object") throw new Error("Invalid skill operation.");
    const name = validateSkillName(operation.name);
    if (operation.action === "create") {
      return {
        ...operation,
        action: "create",
        name,
        description: validateSkillDescription(operation.description || ""),
        content: validateSkillContent(operation.content || ""),
      };
    }
    if (operation.action === "patch") {
      const oldText = (operation.oldText || "").trim();
      if (!oldText) throw new Error("Skill patch requires oldText.");
      const newText = validateSkillContent(operation.newText || "");
      return { ...operation, action: "patch", name, oldText, newText };
    }
    if (operation.action === "archive") return { ...operation, action: "archive", name };
    throw new Error("Unknown skill operation.");
  }

  private async applyOperation(operation: SkillOperation, origin: SkillWriteOrigin, proposalId: string): Promise<SkillMutationResult> {
    const validated = this.validateOperation(operation);
    const timestamp = this.timestamp();
    if (validated.action === "create") {
      const path = join(this.skillsDir, validated.name, SKILL_FILE);
      if (await this.exists(path)) throw new Error(`Skill '${validated.name}' already exists.`);
      const skill: ProjectSkill = {
        name: validated.name,
        description: validated.description!,
        content: validated.content!,
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: origin,
        updatedBy: origin,
        state: "active",
        useCount: 0,
        viewCount: 0,
        patchCount: 0,
      };
      await this.atomicWrite(path, renderSkillFile(skill));
      return { changed: true, message: `Created project skill '${skill.name}'.`, skill };
    }

    const existing = await this.loadSkill(validated.name);
    if (validated.action === "patch") {
      const matches = existing.content.split(validated.oldText!).length - 1;
      if (matches !== 1) throw new Error(`Skill patch text must match exactly once (found ${matches}).`);
      const content = validateSkillContent(existing.content.replace(validated.oldText!, validated.newText!));
      const next: ProjectSkill = {
        ...existing,
        content,
        updatedAt: timestamp,
        updatedBy: origin,
        patchCount: existing.patchCount + 1,
        lastPatchedAt: timestamp,
      };
      await this.backupSkill(existing, proposalId);
      await this.atomicWrite(join(this.skillsDir, next.name, SKILL_FILE), renderSkillFile(next));
      return { changed: true, message: `Patched project skill '${next.name}'.`, skill: next };
    }

    await this.backupSkill(existing, proposalId);
    const source = join(this.skillsDir, existing.name);
    const target = join(this.archiveDir, `${existing.name}-${timestamp.replace(/[^0-9]/gu, "").slice(0, 14)}`);
    await rename(source, target);
    return { changed: true, message: `Archived project skill '${existing.name}'.`, skill: { ...existing, state: "archived" } };
  }

  private async backupSkill(skill: ProjectSkill, proposalId: string): Promise<void> {
    await this.atomicWrite(join(this.revisionsDir, proposalId, skill.name, SKILL_FILE), renderSkillFile(skill));
  }

  private async touchUsage(name: string, kind: "view" | "use"): Promise<void> {
    await this.withLock(async () => {
      const skill = await this.loadSkill(name);
      const timestamp = this.timestamp();
      const next = {
        ...skill,
        ...(kind === "view" ? { viewCount: skill.viewCount + 1, lastViewedAt: timestamp } : { useCount: skill.useCount + 1, lastUsedAt: timestamp }),
      } satisfies ProjectSkill;
      await this.atomicWrite(join(this.skillsDir, name, SKILL_FILE), renderSkillFile(next));
    });
  }

  private async readProposal(path: string): Promise<SkillProposal> {
    const value = await this.readJson(path);
    if (!isRecord(value) || value.version !== SKILL_STORE_VERSION || !Array.isArray(value.operations)) throw new Error("Invalid skill proposal.");
    return {
      version: SKILL_STORE_VERSION,
      id: typeof value.id === "string" ? value.id : "unknown",
      createdAt: typeof value.createdAt === "string" ? value.createdAt : this.timestamp(),
      ...(typeof value.sourceSessionId === "string" ? { sourceSessionId: value.sourceSessionId } : {}),
      operations: value.operations.map((operation) => this.validateOperation(operation as SkillOperation)),
    };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async readJson(path: string): Promise<unknown> {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  }

  private async atomicWrite(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
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
    await mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    const owner = `${process.pid}:${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    while (!handle) {
      try {
        handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(`${owner}\n${Date.now()}\n`, "utf8");
      } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        handle = undefined;
        if (!isErrno(error, "EEXIST")) throw error;
        try {
          const info = await stat(this.lockPath);
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await unlink(this.lockPath).catch(() => undefined);
        } catch (statError) {
          if (!isErrno(statError, "ENOENT")) throw statError;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for project skill lock: ${this.lockPath}`);
        await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 25)));
      }
    }
    try {
      return await fn();
    } finally {
      await handle.close().catch(() => undefined);
      const current = await readFile(this.lockPath, "utf8").catch(() => "");
      if (current.startsWith(`${owner}\n`)) await unlink(this.lockPath).catch(() => undefined);
    }
  }
}
