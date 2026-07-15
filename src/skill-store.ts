import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteFile } from "./atomic-file.ts";
import { withFileLock } from "./file-lock.ts";
import { SkillActivityIndex } from "./skill-activity.ts";
import { optionalIsoTimestamp, requireNonnegativeInteger } from "./state-validation.ts";
import { projectStorageDir } from "./store.ts";
import {
  DEFAULT_SKILL_RETENTION_SESSIONS,
  DEFAULT_SKILL_REVIEW_INTERVAL,
  DEFAULT_SKILL_REVIEW_SIGNAL_THRESHOLD,
  MAX_SKILL_CONTENT_CHARS,
  SKILL_STORE_VERSION,
  type ProjectSkill,
  type SkillMutationResult,
  type SkillOperation,
  type SkillProposal,
  type SkillReviewState,
  type SkillSessionMaintenance,
  type SkillUseResult,
  type SkillWriteOrigin,
} from "./skill-types.ts";
import {
  validateSkillContent,
  validateSkillDescription,
  validateSkillMetadataText,
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
const MAX_SKILL_INDEX_CHARS = 6_000;
const MAX_SKILL_JSON_BYTES = 5 * 1024 * 1024;

function retrievalVariants(term: string): string[] {
  const variants = [term];
  const replacements: ReadonlyArray<readonly [RegExp, string]> = [
    [/ability$/u, "able"],
    [/ification$/u, "ify"],
    [/ied$/u, "y"],
    [/ies$/u, "y"],
    [/ing$/u, ""],
    [/ed$/u, ""],
    [/s$/u, ""],
  ];
  const rule = replacements.find(([pattern]) => pattern.test(term));
  if (!rule) return variants;
  const stem = term.replace(rule[0], rule[1]);
  if (stem.length > 2 && stem !== term) variants.push(stem);
  if (term.endsWith("ing") && stem.length > 2) {
    if (!stem.endsWith("e")) variants.push(`${stem}e`);
    if (/([^aeiou])\1$/u.test(stem)) variants.push(stem.slice(0, -1));
  }
  return variants;
}

function retrievalTerms(value: string): string[] {
  const tokens = value.normalize("NFKC").slice(0, MAX_RETRIEVAL_QUERY_CHARS).toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  return [...new Set(tokens
    .filter((term) => term.length > 2 && !RETRIEVAL_STOP_WORDS.has(term))
    .flatMap(retrievalVariants))]
    .slice(0, MAX_RETRIEVAL_TERMS);
}

interface SkillStoreOptions {
  storageRoot?: string;
  projectDir?: string;
  now?: () => Date;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function validateProposalId(id: string): string {
  const normalized = id.trim();
  if (!/^\d{14}-[0-9a-f]{8}$/u.test(normalized)) throw new Error("Invalid skill proposal id.");
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emptyReviewState(): SkillReviewState {
  return { version: SKILL_STORE_VERSION, turnsSinceReview: 0, signalScore: 0, consecutiveFailures: 0 };
}

function parseReviewState(value: unknown): SkillReviewState {
  if (!isRecord(value)) throw new Error("Invalid project skill review state.");
  if (value.version !== SKILL_STORE_VERSION) throw new Error("Unsupported project skill review state.");
  return {
    version: SKILL_STORE_VERSION,
    turnsSinceReview: requireNonnegativeInteger(value.turnsSinceReview, "project skill review turn count"),
    signalScore: requireNonnegativeInteger(value.signalScore, "project skill review signal score"),
    consecutiveFailures: requireNonnegativeInteger(value.consecutiveFailures, "project skill review failure count"),
    lastReviewedAt: optionalIsoTimestamp(value.lastReviewedAt, "project skill review timestamp"),
    lastAttemptAt: optionalIsoTimestamp(value.lastAttemptAt, "project skill review attempt timestamp"),
    nextAttemptAt: optionalIsoTimestamp(value.nextAttemptAt, "project skill review retry timestamp"),
    inFlightUntil: optionalIsoTimestamp(value.inFlightUntil, "project skill review lease timestamp"),
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
  const createdAt = fields.get("createdAt") || now;
  const storedGeneration = fields.get("generationId");
  const generationId = storedGeneration && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(storedGeneration)
    ? storedGeneration
    : createHash("sha256").update(`${name}\0${createdAt}`).digest("hex").slice(0, 24);
  const numberField = (key: string) => {
    const value = Number(fields.get(key) || 0);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  };
  return {
    name,
    generationId,
    description,
    content,
    createdAt,
    updatedAt: fields.get("updatedAt") || now,
    createdBy: fields.get("createdBy") === "foreground" ? "foreground" : "background_review",
    updatedBy: fields.get("updatedBy") === "foreground" ? "foreground" : "background_review",
    state: "active",
    useCount: numberField("useCount"),
    useSessionCount: numberField("useSessionCount"),
    viewCount: numberField("viewCount"),
    patchCount: numberField("patchCount"),
    createdSession: numberField("createdSession"),
    lastUsedSession: numberField("lastUsedSession") || undefined,
    lastRetentionSession: numberField("lastRetentionSession") || undefined,
    lastUsedAt: fields.get("lastUsedAt"),
    lastRetentionAt: fields.get("lastRetentionAt"),
    lastViewedAt: fields.get("lastViewedAt"),
    lastPatchedAt: fields.get("lastPatchedAt"),
  };
}

function renderSkillFile(skill: ProjectSkill): string {
  return [
    "---",
    `name: ${skill.name}`,
    `generationId: ${skill.generationId}`,
    `description: ${JSON.stringify(skill.description)}`,
    "version: 0.1.0",
    "author: No Forgetti",
    `createdAt: ${skill.createdAt}`,
    `updatedAt: ${skill.updatedAt}`,
    `createdBy: ${skill.createdBy}`,
    `updatedBy: ${skill.updatedBy}`,
    `useCount: ${skill.useCount}`,
    `useSessionCount: ${skill.useSessionCount}`,
    `viewCount: ${skill.viewCount}`,
    `patchCount: ${skill.patchCount}`,
    `createdSession: ${skill.createdSession}`,
    ...(skill.lastUsedSession !== undefined ? [`lastUsedSession: ${skill.lastUsedSession}`] : []),
    ...(skill.lastRetentionSession !== undefined ? [`lastRetentionSession: ${skill.lastRetentionSession}`] : []),
    ...(skill.lastUsedAt ? [`lastUsedAt: ${skill.lastUsedAt}`] : []),
    ...(skill.lastRetentionAt ? [`lastRetentionAt: ${skill.lastRetentionAt}`] : []),
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
  readonly activityPath: string;
  readonly activity: SkillActivityIndex;

  private readonly lockPath: string;
  private readonly now: () => Date;

  constructor(projectRoot: string, options: SkillStoreOptions = {}) {
    this.projectDir = options.projectDir ?? projectStorageDir(projectRoot, options.storageRoot);
    this.skillsDir = join(this.projectDir, "skills");
    this.archiveDir = join(this.skillsDir, ".archive");
    this.pendingDir = join(this.projectDir, "skill-pending");
    this.revisionsDir = join(this.projectDir, "skill-revisions");
    this.reviewPath = join(this.projectDir, "skill-review.json");
    this.activityPath = join(this.projectDir, "skill-activity.json");
    this.lockPath = join(this.projectDir, ".lock");
    this.now = options.now ?? (() => new Date());
    this.activity = new SkillActivityIndex(this.projectDir, { now: this.now });
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
      const storedSkills = await this.listStoredSkills();
      const aliases = Object.fromEntries(storedSkills.flatMap((skill) => [[skill.name, skill.generationId], [skill.generationId, skill.generationId]]));
      const seeds = Object.fromEntries(storedSkills.map((skill) => [skill.generationId, {
        useCount: skill.useCount,
        useSessionCount: skill.useSessionCount,
        ...(skill.lastUsedSession ? { lastUsedCompletedSession: skill.lastUsedSession } : {}),
        ...(skill.lastUsedAt ? { lastUsedAt: skill.lastUsedAt } : {}),
      }]));
      await this.activity.initialize({ legacyPath: this.activityPath, generationAliases: aliases, generationSeeds: seeds });
      for (const skill of storedSkills) {
        const path = join(this.skillsDir, skill.name, SKILL_FILE);
        const source = await readFile(path, "utf8");
        const hydrated = await this.hydrateUsage(skill);
        const staleUsage = skill.useCount !== hydrated.useCount
          || skill.useSessionCount !== hydrated.useSessionCount
          || skill.lastUsedSession !== hydrated.lastUsedSession
          || skill.lastUsedAt !== hydrated.lastUsedAt;
        if (!source.includes("\ngenerationId:") || staleUsage) await this.atomicWrite(path, renderSkillFile(hydrated));
      }
    });
  }

  async listSkills(): Promise<ProjectSkill[]> {
    return Promise.all((await this.listStoredSkills()).map((skill) => this.hydrateUsage(skill)));
  }

  async loadSkill(name: string): Promise<ProjectSkill> {
    return this.hydrateUsage(await this.loadStoredSkill(name));
  }

  private async hydrateUsage(skill: ProjectSkill): Promise<ProjectSkill> {
    const usage = await this.activity.generationUsage(skill.generationId);
    return {
      ...skill,
      useCount: usage.useCount,
      useSessionCount: usage.useSessionCount,
      lastUsedSession: usage.lastUsedCompletedSession,
      lastUsedAt: usage.lastUsedAt,
    };
  }

  async skillIndex(): Promise<string> {
    const skills = await this.listSkills();
    if (skills.length === 0) return "(no project skills have been formed yet)";
    const lines: string[] = [];
    let usedChars = 0;
    for (const skill of skills) {
      const line = `- ${skill.name}: ${skill.description} (${skill.useSessionCount} sessions, ${skill.useCount} recalls)`;
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

  async usageReport(retentionSessions = DEFAULT_SKILL_RETENTION_SESSIONS): Promise<string> {
    return this.withLock(async () => {
      const completedCount = await this.activity.completedCount();
      const skills = await this.listSkills();
      if (skills.length === 0) return `(no project skills have been formed yet)\ncompleted project sessions: ${completedCount}`;
      const lines = [`completed project sessions: ${completedCount} · retention: ${retentionSessions}`];
      let chars = lines[0]!.length + 1;
      for (const skill of skills) {
        const eligibleSessions = Math.max(1, completedCount - skill.createdSession);
        const inactiveSessions = Math.max(0, completedCount - (skill.lastUsedSession ?? skill.createdSession));
        const retentionBaseline = Math.max(skill.createdSession, skill.lastUsedSession ?? 0, skill.lastRetentionSession ?? 0);
        const retentionInactive = Math.max(0, completedCount - retentionBaseline);
        const rate = Math.round((skill.useSessionCount / eligibleSessions) * 100);
        const status = retentionInactive >= retentionSessions ? "stale" : `${inactiveSessions} inactive · cull in ${retentionSessions - retentionInactive}`;
        const line = `${skill.name}: ${skill.useSessionCount}/${eligibleSessions} sessions ${rate}% · ${skill.useCount} recalls · ${status}`;
        if (chars + line.length + 1 > MAX_SKILL_INDEX_CHARS) {
          lines.push(`[TRUNCATED: ${skills.length - (lines.length - 1)} more skills]`);
          break;
        }
        lines.push(line);
        chars += line.length + 1;
      }
      return lines.join("\n");
    });
  }

  async maintainSession(sessionId: string): Promise<SkillSessionMaintenance> {
    return this.withLock(async () => {
      const result = await this.activity.beginSession(sessionId);
      return { sessionCount: result.completedCount, isNew: result.isNew, proposals: [] };
    });
  }

  async completeSession(
    sessionId: string,
    retentionSessions = DEFAULT_SKILL_RETENTION_SESSIONS,
  ): Promise<SkillSessionMaintenance> {
    const threshold = Number.isFinite(retentionSessions) ? Math.max(1, Math.floor(retentionSessions)) : DEFAULT_SKILL_RETENTION_SESSIONS;
    return this.withLock(async () => {
      const completion = await this.activity.completeSession(sessionId);
      const completedCount = completion.completedCount;
      const skills = await this.listSkills();
      const pending = await this.listPending();
      const pendingArchives = new Set(pending
        .filter((proposal) => proposal.operations[0]?.action === "archive")
        .map((proposal) => proposal.operations[0]!.name));
      const stale = skills
        .map((skill) => ({
          skill,
          inactiveSessions: completedCount - Math.max(skill.createdSession, skill.lastUsedSession ?? 0, skill.lastRetentionSession ?? 0),
        }))
        .filter(({ skill, inactiveSessions }) => inactiveSessions >= threshold && !pendingArchives.has(skill.name))
        .sort((a, b) => b.inactiveSessions - a.inactiveSessions || a.skill.name.localeCompare(b.skill.name));
      const proposals: SkillProposal[] = [];
      for (const candidate of stale) {
        const proposal = this.createProposal([{
          action: "archive",
          name: candidate.skill.name,
          reason: `Unused for ${candidate.inactiveSessions} completed project sessions (retention: ${threshold}).`,
        }], undefined, true, completedCount, threshold);
        await this.atomicWrite(join(this.pendingDir, `${proposal.id}.json`), proposal);
        proposals.push(proposal);
      }
      return { sessionCount: completedCount, isNew: completion.isNew, proposals };
    });
  }

  async viewSkill(name: string): Promise<ProjectSkill> {
    const skill = await this.loadSkill(name);
    await this.touchUsage(skill.name, "view");
    return skill;
  }

  async recordUse(name: string, sessionId: string): Promise<SkillUseResult> {
    return this.touchUsage(validateSkillName(name), "use", sessionId);
  }

  async stageProposal(operations: SkillOperation[], sourceSessionId?: string): Promise<SkillProposal> {
    const proposal = this.createProposal(operations, sourceSessionId);
    return this.withLock(async () => {
      const operation = proposal.operations[0];
      const existing = (await this.listPending()).find((item) => (
        item.operations[0]?.action === operation?.action && item.operations[0]?.name === operation?.name
      ));
      if (existing) return existing;
      await this.atomicWrite(join(this.pendingDir, `${proposal.id}.json`), proposal);
      return proposal;
    });
  }

  async submitProposal(
    operations: SkillOperation[],
    sourceSessionId?: string,
  ): Promise<{ proposal: SkillProposal; staged: boolean }> {
    const existingIds = new Set((await this.listPending()).map((proposal) => proposal.id));
    const proposal = await this.stageProposal(operations, sourceSessionId);
    return { proposal, staged: !existingIds.has(proposal.id) };
  }

  async listPending(): Promise<SkillProposal[]> {
    const entries = await readdir(this.pendingDir, { withFileTypes: true });
    const proposals: SkillProposal[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const value = await this.readJson(join(this.pendingDir, entry.name));
      if (!isRecord(value) || value.version !== SKILL_STORE_VERSION || !Array.isArray(value.operations)) continue;
      const filenameId = validateProposalId(entry.name.slice(0, -5));
      proposals.push(this.parseProposal(value, filenameId));
    }
    return proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async pendingIndex(): Promise<string> {
    const pending = await this.listPending();
    if (pending.length === 0) return "(no pending project skill proposals)";
    const lines: string[] = [];
    let chars = 0;
    for (const proposal of pending) {
      const operation = proposal.operations[0];
      const line = `- ${proposal.id}: ${operation?.action ?? "empty"} ${operation?.name ?? ""}`;
      if (chars + line.length + 1 > MAX_SKILL_INDEX_CHARS) {
        lines.push(`[TRUNCATED: ${pending.length - lines.length} more proposals]`);
        break;
      }
      lines.push(line);
      chars += line.length + 1;
    }
    return lines.join("\n");
  }

  async approveProposal(id: string, origin: SkillWriteOrigin = "background_review"): Promise<SkillMutationResult> {
    const safeId = validateProposalId(id);
    return this.withLock(async () => {
      const path = join(this.pendingDir, `${safeId}.json`);
      const proposal = await this.readProposal(path, safeId);
      const operation = proposal.operations[0];
      if (!operation) {
        await unlink(path);
        return { changed: false, message: `Skill proposal '${safeId}' was empty.` };
      }
      if (proposal.retention && operation.action === "archive") {
        const skill = await this.loadSkill(operation.name);
        const completedCount = await this.activity.completedCount();
        const baseline = Math.max(skill.createdSession, skill.lastUsedSession ?? 0, skill.lastRetentionSession ?? 0);
        const threshold = proposal.retentionAfterSessions ?? DEFAULT_SKILL_RETENTION_SESSIONS;
        if (completedCount - baseline < threshold) {
          await unlink(path);
          return { changed: false, message: `Skill '${skill.name}' is no longer stale; discarded retention proposal.` };
        }
      }
      const result = await this.applyOperation(operation, origin, safeId);
      if (result.changed) await unlink(path);
      return result;
    });
  }

  async rejectProposal(id: string): Promise<void> {
    const safeId = validateProposalId(id);
    await this.withLock(async () => {
      const path = join(this.pendingDir, `${safeId}.json`);
      const proposal = await this.readProposal(path, safeId);
      const operation = proposal.operations[0];
      if (proposal.retention && operation?.action === "archive") {
        const skill = await this.loadSkill(operation.name);
        const completedCount = await this.activity.completedCount();
        await this.atomicWrite(join(this.skillsDir, skill.name, SKILL_FILE), renderSkillFile({
          ...skill,
          lastRetentionSession: completedCount,
          lastRetentionAt: this.timestamp(),
        }));
      }
      await unlink(path);
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

  private createProposal(
    operations: SkillOperation[],
    sourceSessionId?: string,
    retention = false,
    retentionSession?: number,
    retentionAfterSessions?: number,
  ): SkillProposal {
    if (operations.length > 1) throw new Error("A self-forming skill review may stage one operation at a time.");
    const normalized = operations.map((operation) => this.validateOperation(operation));
    return {
      version: SKILL_STORE_VERSION,
      id: `${this.timestamp().replace(/[^0-9]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
      createdAt: this.timestamp(),
      ...(sourceSessionId ? { sourceSessionId } : {}),
      ...(retention ? { retention: true } : {}),
      ...(retentionSession !== undefined ? { retentionSession } : {}),
      ...(retentionAfterSessions !== undefined ? { retentionAfterSessions } : {}),
      operations: normalized,
    };
  }

  private validateOperation(operation: SkillOperation): SkillOperation {
    if (!operation || typeof operation !== "object") throw new Error("Invalid skill operation.");
    const name = validateSkillName(operation.name);
    const metadata = {
      ...(operation.reason !== undefined ? { reason: validateSkillMetadataText(operation.reason) } : {}),
      ...(operation.evidence !== undefined ? {
        evidence: operation.evidence.slice(0, 8).map((item) => validateSkillMetadataText(item)),
      } : {}),
    };
    if (operation.action === "create") {
      return {
        ...operation,
        ...metadata,
        action: "create",
        name,
        description: validateSkillDescription(operation.description || ""),
        content: validateSkillContent(operation.content || ""),
      };
    }
    if (operation.action === "patch") {
      const oldText = operation.oldText || "";
      if (!oldText.trim()) throw new Error("Skill patch requires oldText.");
      const newText = operation.newText ?? "";
      if (newText) validateSkillContent(newText);
      return { ...operation, ...metadata, action: "patch", name, oldText, newText };
    }
    if (operation.action === "archive") return { ...operation, ...metadata, action: "archive", name };
    throw new Error("Unknown skill operation.");
  }

  private async applyOperation(operation: SkillOperation, origin: SkillWriteOrigin, proposalId: string): Promise<SkillMutationResult> {
    const validated = this.validateOperation(operation);
    const timestamp = this.timestamp();
    if (validated.action === "create") {
      const path = join(this.skillsDir, validated.name, SKILL_FILE);
      if (await this.exists(path)) throw new Error(`Skill '${validated.name}' already exists.`);
      const completedCount = await this.activity.completedCount();
      const skill: ProjectSkill = {
        name: validated.name,
        generationId: randomUUID(),
        description: validated.description!,
        content: validated.content!,
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: origin,
        updatedBy: origin,
        state: "active",
        useCount: 0,
        useSessionCount: 0,
        viewCount: 0,
        patchCount: 0,
        createdSession: completedCount,
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

  private async touchUsage(name: string, kind: "view" | "use", sessionId?: string): Promise<SkillUseResult> {
    return this.withLock(async () => {
      const skill = await this.loadStoredSkill(name);
      if (kind === "view") {
        await this.atomicWrite(join(this.skillsDir, name, SKILL_FILE), renderSkillFile({
          ...skill,
          viewCount: skill.viewCount + 1,
          lastViewedAt: this.timestamp(),
        }));
        return { withdrawnRetentionProposals: 0 };
      }
      if (!sessionId) throw new Error("Project skill use requires a tracked session.");
      await this.activity.recordUse(sessionId, skill.generationId);
      let withdrawnRetentionProposals = 0;
      for (const proposal of await this.listPending()) {
        if (!proposal.retention || proposal.operations[0]?.action !== "archive" || proposal.operations[0].name !== name) continue;
        await unlink(join(this.pendingDir, `${proposal.id}.json`));
        withdrawnRetentionProposals += 1;
      }
      return { withdrawnRetentionProposals };
    });
  }

  private parseProposal(value: Record<string, unknown>, expectedId: string): SkillProposal {
    if (value.version !== SKILL_STORE_VERSION || !Array.isArray(value.operations)) throw new Error("Invalid skill proposal.");
    const id = validateProposalId(typeof value.id === "string" ? value.id : expectedId);
    if (id !== expectedId) throw new Error("Skill proposal id does not match its filename.");
    return {
      version: SKILL_STORE_VERSION,
      id,
      createdAt: typeof value.createdAt === "string" ? value.createdAt : this.timestamp(),
      ...(typeof value.sourceSessionId === "string" ? { sourceSessionId: value.sourceSessionId } : {}),
      ...(value.retention === true ? { retention: true } : {}),
      ...(typeof value.retentionSession === "number" && Number.isInteger(value.retentionSession) && value.retentionSession >= 0 ? { retentionSession: value.retentionSession } : {}),
      ...(typeof value.retentionAfterSessions === "number" && Number.isInteger(value.retentionAfterSessions) && value.retentionAfterSessions > 0 ? { retentionAfterSessions: value.retentionAfterSessions } : {}),
      operations: value.operations.map((operation) => this.validateOperation(operation as SkillOperation)),
    };
  }

  private async readProposal(path: string, expectedId: string): Promise<SkillProposal> {
    const value = await this.readJson(path);
    if (!isRecord(value)) throw new Error("Invalid skill proposal.");
    return this.parseProposal(value, expectedId);
  }

  private async listStoredSkills(): Promise<ProjectSkill[]> {
    const entries = await readdir(this.skillsDir, { withFileTypes: true });
    const skills: ProjectSkill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        skills.push(await this.loadStoredSkill(entry.name));
      } catch {
        // Invalid packages remain invisible and fail closed when addressed directly.
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async loadStoredSkill(name: string): Promise<ProjectSkill> {
    const normalized = validateSkillName(name);
    const path = join(this.skillsDir, normalized, SKILL_FILE);
    const skill = parseSkillFile(await readFile(path, "utf8"), normalized, this.timestamp());
    if (skill.name !== normalized) throw new Error(`Skill package name mismatch: expected '${normalized}'.`);
    return skill;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async readJson(path: string): Promise<unknown> {
    const info = await stat(path);
    if (info.size > MAX_SKILL_JSON_BYTES) throw new Error(`Project skill JSON exceeds ${MAX_SKILL_JSON_BYTES} bytes: ${path}`);
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  }

  private async atomicWrite(path: string, value: unknown): Promise<void> {
    const serialized = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_SKILL_JSON_BYTES) {
      throw new Error(`Project skill write exceeds ${MAX_SKILL_JSON_BYTES} bytes: ${path}`);
    }
    await atomicWriteFile(path, serialized);
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
    return withFileLock(this.lockPath, LOCK_TIMEOUT_MS, LOCK_STALE_MS, "project skill", fn);
  }
}
