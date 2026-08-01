import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteFile } from "./atomic-file.ts";
import { withFileLock } from "./file-lock.ts";
import { projectSkillSessionKey, SkillActivityIndex } from "./skill-activity.ts";
import { projectSkillContentDigest } from "./skill-content-digest.ts";
import { parseSkillReviewReceipt, skillOperationDigest } from "./skill-review-provenance.ts";
import { exactKeys, isErrno, isRecord, optionalIsoTimestamp, requireNonnegativeInteger } from "./state-validation.ts";
import { projectStorageDir } from "./store.ts";
import {
  DEFAULT_SKILL_RETENTION_SESSIONS,
  DEFAULT_SKILL_REVIEW_INTERVAL,
  DEFAULT_SKILL_REVIEW_SIGNAL_THRESHOLD,
  SKILL_STORE_VERSION,
  type ProjectSkill,
  type SkillMutationResult,
  type SkillOperation,
  type SkillProposal,
  type SkillProposalBinding,
  type SkillReviewClaim,
  type SkillReviewOutcome,
  type SkillReviewReceipt,
  type SkillReviewState,
  type SkillSessionMaintenance,
  type SkillUseResult,
  type SkillWriteOrigin,
} from "./skill-types.ts";
import {
  validateGeneratedSkillContent,
  validateSkillContent,
  validateSkillDescription,
  validateSkillMetadataText,
  validateSkillName,
} from "./skill-security.ts";

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
const SKILL_FILE = "SKILL.md";
const SKILL_REVISION_FILE = "revision.json";
const SKILL_REVIEW_FILE = "review.json";
const SKILL_REVISION_VERSION = 1;
const MAX_SKILL_INDEX_CHARS = 6_000;
const MAX_SKILL_JSON_BYTES = 5 * 1024 * 1024;
const LEGACY_SKILL_REVIEW_STATE_VERSION = 1;
const AGGREGATE_SKILL_REVIEW_STATE_VERSION = 2;
const SKILL_REVIEW_STATE_VERSION = 3;
const SKILL_REVIEW_LEASE_MS = 5 * 60_000;
const SKILL_REVIEW_RETRY_BASE_MS = 5 * 60_000;
const SKILL_REVIEW_RETRY_MAX_MS = 60 * 60_000;
const MAX_SKILL_REVIEW_SESSIONS = 4_096;
const MAX_SKILL_REVIEW_PENDING_TURNS = 4_096;
const MAX_SKILL_REVIEW_SELECTED_TURNS = 12;
const MAX_SKILL_REVIEW_ELIGIBLE_TURNS = 4_108;
const UUID = /^[a-f0-9-]{36}$/u;
const SESSION_KEY = /^[0-9a-f]{32}$/u;
const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

interface SkillStoreOptions {
  storageRoot?: string;
  projectDir?: string;
  now?: () => Date;
}

function validateProposalId(id: string): string {
  const normalized = id.trim();
  if (!/^\d{14}-[0-9a-f]{8}$/u.test(normalized)) throw new Error("Invalid skill proposal id.");
  return normalized;
}

function parseProposalOrigin(value: unknown): SkillWriteOrigin | undefined {
  if (value === undefined) return undefined;
  if (value !== "foreground" && value !== "background_review") throw new Error("Invalid skill proposal origin.");
  return value;
}

function parseProposalBinding(value: unknown): SkillProposalBinding | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid skill proposal binding.");
  exactKeys(value, ["generationId", "contentDigest"]);
  if (typeof value.generationId !== "string"
    || value.generationId.length > 64
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.generationId)
    || typeof value.contentDigest !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.contentDigest)) {
    throw new Error("Invalid skill proposal binding.");
  }
  return { generationId: value.generationId, contentDigest: value.contentDigest };
}

function sameProposalBinding(left: SkillProposalBinding, right: SkillProposalBinding): boolean {
  return left.generationId === right.generationId && left.contentDigest === right.contentDigest;
}

class SkillProposalBindingError extends Error {}

function staleProposalBindingError(name: string, current: SkillProposalBinding, expected: SkillProposalBinding): SkillProposalBindingError {
  const field = current.generationId === expected.generationId ? "content" : "generation";
  return new SkillProposalBindingError(`Discarded project skill proposal '${name}': its bound skill ${field} changed.`);
}

function missingProposalBindingError(name: string): SkillProposalBindingError {
  return new SkillProposalBindingError(`Discarded project skill proposal '${name}': its bound skill target is missing.`);
}

function emptyReviewState(): SkillReviewState {
  return { version: SKILL_REVIEW_STATE_VERSION, sessions: {}, consecutiveFailures: 0, generation: 0 };
}

function reviewEntryId(value: unknown, label = "project skill review entry"): string {
  if (typeof value !== "string" || !ENTRY_ID.test(value)) throw new Error(`Invalid ${label} id.`);
  return value;
}

function reviewEntryIds(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid ${label} entry ids.`);
  const ids = value.map((entryId) => reviewEntryId(entryId, label));
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label} entry id.`);
  return ids;
}

function reviewSessionKey(value: unknown): string {
  if (typeof value !== "string" || !SESSION_KEY.test(value)) throw new Error("Invalid project skill review session key.");
  return value;
}

function requireReviewClaimToken(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid project skill review claim.");
  return value;
}

function requireReviewClaimGeneration(value: unknown): number {
  const generation = requireNonnegativeInteger(value, "project skill review claim generation");
  if (generation === 0) throw new Error("Invalid project skill review claim generation.");
  return generation;
}

function parseReviewClaim(value: unknown): SkillReviewClaim {
  if (!isRecord(value)) throw new Error("Invalid project skill review claim.");
  exactKeys(value, [
    "generation", "token", "sessionKey", "evidenceEntryIds", "capturedTurns", "capturedSignalScore",
  ]);
  const evidenceEntryIds = reviewEntryIds(
    value.evidenceEntryIds,
    "project skill review claimed",
    MAX_SKILL_REVIEW_SELECTED_TURNS,
  );
  const capturedTurns = requireNonnegativeInteger(value.capturedTurns, "project skill review claimed turn count");
  if (capturedTurns !== evidenceEntryIds.length) throw new Error("Invalid project skill review claimed turn count.");
  return {
    generation: requireReviewClaimGeneration(value.generation),
    token: requireReviewClaimToken(value.token),
    sessionKey: reviewSessionKey(value.sessionKey),
    evidenceEntryIds,
    capturedTurns,
    capturedSignalScore: requireNonnegativeInteger(value.capturedSignalScore, "project skill review claimed signal score"),
  };
}

function migrateAggregateReviewState(value: unknown): SkillReviewState {
  if (!isRecord(value)
    || (value.version !== LEGACY_SKILL_REVIEW_STATE_VERSION
      && value.version !== AGGREGATE_SKILL_REVIEW_STATE_VERSION)) {
    throw new Error("Invalid legacy project skill review state.");
  }
  requireNonnegativeInteger(value.turnsSinceReview, "project skill review turn count");
  requireNonnegativeInteger(value.signalScore, "project skill review signal score");
  const generation = value.version === AGGREGATE_SKILL_REVIEW_STATE_VERSION
    ? requireNonnegativeInteger(value.generation ?? 0, "project skill review generation")
    : 0;
  if (value.version === AGGREGATE_SKILL_REVIEW_STATE_VERSION && value.activeClaim !== undefined) {
    const claim = value.activeClaim;
    if (!isRecord(claim)) throw new Error("Invalid legacy project skill review claim.");
    exactKeys(claim, ["generation", "token", "capturedTurns", "capturedSignalScore"]);
    requireReviewClaimGeneration(claim.generation);
    requireReviewClaimToken(claim.token);
    requireNonnegativeInteger(claim.capturedTurns, "project skill review claimed turn count");
    requireNonnegativeInteger(claim.capturedSignalScore, "project skill review claimed signal score");
  }
  return {
    version: SKILL_REVIEW_STATE_VERSION,
    sessions: {},
    consecutiveFailures: requireNonnegativeInteger(value.consecutiveFailures, "project skill review failure count"),
    generation,
    lastReviewedAt: optionalIsoTimestamp(value.lastReviewedAt, "project skill review timestamp"),
    lastAttemptAt: optionalIsoTimestamp(value.lastAttemptAt, "project skill review attempt timestamp"),
    nextAttemptAt: optionalIsoTimestamp(value.nextAttemptAt, "project skill review retry timestamp"),
    inFlightUntil: optionalIsoTimestamp(value.inFlightUntil, "project skill review lease timestamp"),
  };
}

function parseReviewGeneration(value: unknown): number {
  return value === undefined ? 0 : requireNonnegativeInteger(value, "project skill review generation");
}

function parseReviewSessions(value: unknown): SkillReviewState["sessions"] {
  if (!isRecord(value) || Object.keys(value).length > MAX_SKILL_REVIEW_SESSIONS) {
    throw new Error("Invalid project skill review sessions.");
  }
  const sessions: SkillReviewState["sessions"] = {};
  let totalPending = 0;
  for (const [key, rawSession] of Object.entries(value)) {
    const sessionKey = reviewSessionKey(key);
    if (!isRecord(rawSession)) throw new Error("Invalid project skill review session state.");
    exactKeys(rawSession, ["pending"]);
    if (!Array.isArray(rawSession.pending)) throw new Error("Invalid project skill review pending turns.");
    const pending = rawSession.pending.map((rawTurn) => {
      if (!isRecord(rawTurn)) throw new Error("Invalid project skill review pending turn.");
      exactKeys(rawTurn, ["entryId", "signalScore"]);
      const signalScore = requireNonnegativeInteger(rawTurn.signalScore, "project skill review signal score");
      if (signalScore > 5) throw new Error("Project skill review signal score exceeds 5.");
      return {
        entryId: reviewEntryId(rawTurn.entryId),
        signalScore,
      };
    });
    if (new Set(pending.map(({ entryId }) => entryId)).size !== pending.length) {
      throw new Error("Duplicate project skill review pending entry id.");
    }
    totalPending += pending.length;
    if (totalPending > MAX_SKILL_REVIEW_PENDING_TURNS) {
      throw new Error("Project skill review pending turn limit reached.");
    }
    sessions[sessionKey] = { pending };
  }
  return sessions;
}

function parseReviewState(value: unknown): SkillReviewState {
  if (!isRecord(value)) throw new Error("Invalid project skill review state.");
  if (value.version !== SKILL_REVIEW_STATE_VERSION) throw new Error("Unsupported project skill review state.");
  exactKeys(
    value,
    ["version", "sessions", "consecutiveFailures"],
    ["generation", "activeClaim", "lastReviewedAt", "lastAttemptAt", "nextAttemptAt", "inFlightUntil"],
  );
  const generation = parseReviewGeneration(value.generation);
  const activeClaim = value.activeClaim === undefined ? undefined : parseReviewClaim(value.activeClaim);
  if (activeClaim && activeClaim.generation !== generation) {
    throw new Error("Project skill review claim generation mismatch.");
  }
  return {
    version: SKILL_REVIEW_STATE_VERSION,
    sessions: parseReviewSessions(value.sessions),
    consecutiveFailures: requireNonnegativeInteger(value.consecutiveFailures, "project skill review failure count"),
    generation,
    activeClaim,
    lastReviewedAt: optionalIsoTimestamp(value.lastReviewedAt, "project skill review timestamp"),
    lastAttemptAt: optionalIsoTimestamp(value.lastAttemptAt, "project skill review attempt timestamp"),
    nextAttemptAt: optionalIsoTimestamp(value.nextAttemptAt, "project skill review retry timestamp"),
    inFlightUntil: optionalIsoTimestamp(value.inFlightUntil, "project skill review lease timestamp"),
  };
}

const SKILL_REVIEW_OUTCOMES = new Set<unknown>(["success", "failure", "cancelled"]);

function parseReviewOutcome(value: unknown): SkillReviewOutcome {
  if (!SKILL_REVIEW_OUTCOMES.has(value)) throw new Error("Invalid project skill review settlement.");
  return value as SkillReviewOutcome;
}

function parseReviewSettlement(value: unknown): { claim: SkillReviewClaim; outcome: SkillReviewOutcome } {
  if (!isRecord(value)) throw new Error("Invalid project skill review settlement.");
  exactKeys(value, ["claim", "outcome"]);
  return { claim: parseReviewClaim(value.claim), outcome: parseReviewOutcome(value.outcome) };
}

function countOccurrences(text: string, search: string): number {
  return text.split(search).length - 1;
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

/** Diff source: a patch may land in either the description or the body. */
function skillText(skill: ProjectSkill): string {
  return `${skill.description}\n\n${skill.content}`;
}

function skillRevisionDigest(skill: Pick<ProjectSkill, "generationId" | "description" | "content" | "patchCount">): string {
  const canonical = JSON.stringify([skill.generationId, skill.description, skill.content, skill.patchCount]);
  return createHash("sha256").update(`no-forgetti/project-skill-revision/v1\0${canonical}`, "utf8").digest("hex");
}

interface SkillRevisionMetadata {
  version: typeof SKILL_REVISION_VERSION;
  generationId: string;
  beforeDigest: string;
  expectedAfterDigest: string;
  review?: SkillReviewReceipt;
}

function parseSkillRevisionMetadata(value: unknown): SkillRevisionMetadata {
  if (!isRecord(value)) throw new Error("Invalid project skill revision metadata.");
  exactKeys(value, ["version", "generationId", "beforeDigest", "expectedAfterDigest"], ["review"]);
  if (value.version !== SKILL_REVISION_VERSION
    || typeof value.generationId !== "string"
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.generationId)
    || typeof value.beforeDigest !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.beforeDigest)
    || typeof value.expectedAfterDigest !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.expectedAfterDigest)) {
    throw new Error("Invalid project skill revision metadata.");
  }
  return {
    version: SKILL_REVISION_VERSION,
    generationId: value.generationId,
    beforeDigest: value.beforeDigest,
    expectedAfterDigest: value.expectedAfterDigest,
    ...(value.review === undefined ? {} : { review: parseSkillReviewReceipt(value.review) }),
  };
}

export class ProjectSkillStore {
  readonly projectDir: string;
  readonly skillsDir: string;
  readonly archiveDir: string;
  readonly pendingDir: string;
  readonly invalidPendingDir: string;
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
    this.invalidPendingDir = join(this.pendingDir, ".invalid");
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
    await mkdir(this.invalidPendingDir, { recursive: true, mode: 0o700 });
    await mkdir(this.revisionsDir, { recursive: true, mode: 0o700 });
    await this.withLock(async () => {
      if (!await this.exists(this.reviewPath)) {
        await this.atomicWrite(this.reviewPath, emptyReviewState());
      } else {
        const persistedReviewState = await this.readJson(this.reviewPath);
        if (isRecord(persistedReviewState)
          && (persistedReviewState.version === LEGACY_SKILL_REVIEW_STATE_VERSION
            || persistedReviewState.version === AGGREGATE_SKILL_REVIEW_STATE_VERSION)) {
          await this.atomicWrite(this.reviewPath, migrateAggregateReviewState(persistedReviewState));
        } else {
          parseReviewState(persistedReviewState);
        }
      }
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

  /** Capture one lock-consistent corpus view for authorship evidence. */
  async captureAuthorshipCorpus(): Promise<{ skills: ProjectSkill[]; pending: SkillProposal[] }> {
    return this.withLock(async () => ({
      skills: await this.listSkills(),
      pending: await this.listPending(),
    }));
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
      const skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
      const pendingArchives = new Set<string>();
      for (const proposal of pending) {
        const operation = proposal.operations.at(0);
        if (operation?.action !== "archive") continue;
        const skill = skillsByName.get(operation.name);
        const current = skill && proposal.binding
          && skill.generationId === proposal.binding.generationId
          && projectSkillContentDigest(skill) === proposal.binding.contentDigest;
        if (current) pendingArchives.add(operation.name);
        else await unlink(join(this.pendingDir, `${proposal.id}.json`));
      }
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
        }], undefined, true, completedCount, threshold, this.proposalBinding(candidate.skill), "background_review");
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

  private async stageProposalResult(
    operations: SkillOperation[],
    sourceSessionId: string | undefined,
    origin: SkillWriteOrigin,
    expectedBinding?: SkillProposalBinding,
    review?: SkillReviewReceipt,
  ): Promise<{ proposal: SkillProposal; created: boolean }> {
    const normalized = this.validateOperations(operations);
    return this.withLock(async () => {
      const operation = normalized.at(0);
      let binding: SkillProposalBinding | undefined;
      if (operation && operation.action !== "create") {
        let current: ProjectSkill;
        try {
          current = await this.loadStoredSkill(operation.name);
        } catch (error) {
          if (expectedBinding && isErrno(error, "ENOENT")) throw missingProposalBindingError(operation.name);
          throw error;
        }
        const currentBinding = this.proposalBinding(current);
        if (expectedBinding && !sameProposalBinding(currentBinding, expectedBinding)) {
          throw staleProposalBindingError(operation.name, currentBinding, expectedBinding);
        }
        binding = expectedBinding ?? currentBinding;
      } else if (expectedBinding) {
        throw new Error("Project skill create proposals cannot carry a target binding.");
      }
      const proposal = this.createProposal(normalized, sourceSessionId, false, undefined, undefined, binding, origin, review);
      const identity = JSON.stringify({
        origin: proposal.origin,
        binding: proposal.binding,
        review: proposal.review,
        operations: proposal.operations,
      });
      const existing = (await this.listPending()).find((item) => (
        JSON.stringify({
          origin: item.origin,
          binding: item.binding,
          review: item.review,
          operations: item.operations,
        }) === identity
      ));
      if (existing) return { proposal: existing, created: false };
      await this.atomicWrite(join(this.pendingDir, `${proposal.id}.json`), proposal);
      return { proposal, created: true };
    });
  }

  async stageProposal(
    operations: SkillOperation[],
    sourceSessionId?: string,
    origin: SkillWriteOrigin = "foreground",
    expectedBinding?: SkillProposalBinding,
  ): Promise<SkillProposal> {
    return (await this.stageProposalResult(operations, sourceSessionId, origin, expectedBinding)).proposal;
  }

  async submitProposal(
    operations: SkillOperation[],
    sourceSessionId?: string,
    origin: SkillWriteOrigin = "background_review",
    expectedBinding?: SkillProposalBinding,
    review?: SkillReviewReceipt,
  ): Promise<{ proposal: SkillProposal; staged: boolean; result?: SkillMutationResult }> {
    const normalized = this.validateOperations(operations);
    const operation = normalized.at(0);
    if (origin === "background_review" && operation?.action === "create") {
      validateGeneratedSkillContent(operation.content || "");
    }
    if (origin === "background_review" && operation?.action === "patch") {
      const invalid = await this.withLock(async () => {
        let current: ProjectSkill;
        try {
          current = await this.loadStoredSkill(operation.name);
        } catch (error) {
          if (expectedBinding && isErrno(error, "ENOENT")) throw missingProposalBindingError(operation.name);
          throw error;
        }
        const binding = this.proposalBinding(current);
        if (expectedBinding && !sameProposalBinding(binding, expectedBinding)) {
          throw staleProposalBindingError(operation.name, binding, expectedBinding);
        }
        if (!await this.invalidPatchResult(operation, true)) return undefined;
        return this.createProposal(
          normalized,
          sourceSessionId,
          false,
          undefined,
          undefined,
          expectedBinding ?? binding,
          origin,
        );
      });
      if (invalid) {
        return {
          proposal: invalid,
          staged: false,
          result: { changed: false, message: `Discarded invalid project skill proposal '${operation.name}'.` },
        };
      }
    }
    const staged = await this.stageProposalResult(normalized, sourceSessionId, origin, expectedBinding, review);
    const action = staged.proposal.operations.at(0)?.action;
    if (action === "create" && staged.created) {
      return {
        proposal: staged.proposal,
        staged: false,
        result: await this.approveProposal(staged.proposal.id, origin),
      };
    }
    return { proposal: staged.proposal, staged: staged.created };
  }

  async submitReviewProposal(request: {
    operations: SkillOperation[];
    sourceSessionId?: string;
    binding?: SkillProposalBinding;
    review: SkillReviewReceipt;
  }): Promise<
    | { discarded: true; kind: "invalid-admission" | "stale-conflict"; message: string }
    | { discarded: false; proposal: SkillProposal; staged: boolean; result?: SkillMutationResult }
  > {
    const { operations, sourceSessionId, binding } = request;
    try {
      const normalized = this.validateOperations(operations);
      const operation = normalized.at(0);
      if (operation?.action === "create") validateGeneratedSkillContent(operation.content || "");
      const review = parseSkillReviewReceipt(request.review);
      if (review.operationDigest !== skillOperationDigest(normalized)) {
        throw new Error("Project skill review receipt operation digest mismatch.");
      }
      if (!operation || review.target.name !== operation.name) {
        throw new Error("Project skill review receipt target name mismatch.");
      }
      if (operation.action === "create") {
        if (binding || review.target.kind !== "absent") {
          throw new Error("Project skill create receipt must bind captured target absence.");
        }
      } else if (!binding
        || review.target.kind !== "existing"
        || binding.generationId !== review.target.generationId
        || binding.contentDigest !== review.target.contentDigest) {
        throw new Error("Project skill review receipt target binding mismatch.");
      }
    } catch {
      return { discarded: true, kind: "invalid-admission", message: "Discarded invalid project skill proposal." };
    }
    let submission;
    try {
      submission = await this.submitProposal(operations, sourceSessionId, "background_review", binding, request.review);
    } catch (error) {
      if (error instanceof SkillProposalBindingError) {
        return { discarded: true, kind: "stale-conflict", message: error.message };
      }
      throw error;
    }
    if (submission.result && !submission.result.changed) {
      return {
        discarded: true,
        kind: submission.result.message.startsWith("Discarded invalid") ? "invalid-admission" : "stale-conflict",
        message: submission.result.message,
      };
    }
    return { discarded: false, ...submission };
  }

  /** Rendered diff source for the last recorded change to `name`, newest revision first. */
  async lastChange(name: string): Promise<{ before: string; current: string } | undefined> {
    const current = await this.loadStoredSkill(name);
    const snapshot = await this.previousRevision(current);
    return snapshot ? { before: skillText(snapshot), current: skillText(current) } : undefined;
  }

  async undoLastPatch(name: string): Promise<SkillMutationResult> {
    const skillName = validateSkillName(name);
    return this.withLock(async () => {
      const current = await this.loadStoredSkill(skillName);
      const snapshot = await this.previousRevision(current);
      if (!snapshot) return { changed: false, message: `No recorded change to undo for '${skillName}'.` };
      // Every write path bumps patchCount, so a later edit is always caught. Restoring
      // resets the counter, which makes a second undo of the same revision fail too.
      if (current.patchCount !== snapshot.patchCount + 1) {
        return { changed: false, message: `'${skillName}' changed again after that patch; refusing to undo.` };
      }
      await this.backupSkill(current, this.newProposalId());
      // Restore authored content state only. Usage, views, and retention remain live metadata.
      const restored: ProjectSkill = {
        ...current,
        description: snapshot.description,
        content: snapshot.content,
        updatedAt: snapshot.updatedAt,
        updatedBy: snapshot.updatedBy,
        patchCount: snapshot.patchCount,
        lastPatchedAt: snapshot.lastPatchedAt,
      };
      await this.atomicWrite(join(this.skillsDir, skillName, SKILL_FILE), renderSkillFile(restored));
      return { changed: true, message: `Reverted the last change to project skill '${skillName}'.`, skill: restored };
    });
  }

  /** Select the unique revision whose frozen post-state matches the current skill. */
  private async previousRevision(current: ProjectSkill): Promise<ProjectSkill | undefined> {
    const entries = await readdir(this.revisionsDir, { withFileTypes: true });
    const ids = entries
      .filter((entry) => entry.isDirectory() && /^\d{14}-[0-9a-f]{8}$/u.test(entry.name))
      .map((entry) => entry.name);
    const exact: ProjectSkill[] = [];
    const legacy: ProjectSkill[] = [];
    const currentDigest = skillRevisionDigest(current);
    for (const id of ids) {
      const revisionDir = join(this.revisionsDir, validateProposalId(id), current.name);
      let snapshot: ProjectSkill;
      try {
        snapshot = parseSkillFile(await readFile(join(revisionDir, SKILL_FILE), "utf8"), current.name, this.timestamp());
      } catch {
        continue;
      }
      if (snapshot.generationId !== current.generationId) continue;
      let metadata: SkillRevisionMetadata | undefined;
      try {
        metadata = parseSkillRevisionMetadata(await this.readJson(join(revisionDir, SKILL_REVISION_FILE)));
      } catch (error) {
        if (!isErrno(error, "ENOENT")) continue;
      }
      if (metadata) {
        if (metadata.generationId === current.generationId
          && metadata.beforeDigest === skillRevisionDigest(snapshot)
          && metadata.expectedAfterDigest === currentDigest) exact.push(snapshot);
      } else if (snapshot.patchCount === current.patchCount - 1) {
        legacy.push(snapshot);
      }
    }
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return undefined;
    return legacy.length === 1 ? legacy[0] : undefined;
  }

  /**
   * Repairs the explicit-approval regression shipped before creates became automatic.
   * Older project stores may still contain valid create proposals, so startup applies
   * those safely while leaving destructive patches, archives, and conflicts pending.
   */
  async applyPendingCreates(): Promise<{ applied: string[]; retained: string[] }> {
    const applied: string[] = [];
    const retained: string[] = [];
    for (const proposal of await this.listPending()) {
      const operation = proposal.operations.at(0);
      if (operation?.action !== "create") continue;
      try {
        const result = await this.approveProposal(proposal.id, "background_review");
        if (result.changed) applied.push(operation.name);
        else retained.push(operation.name);
      } catch {
        // Conflicts or concurrent changes remain pending for explicit resolution.
        retained.push(operation.name);
      }
    }
    return { applied, retained };
  }

  async listPending(): Promise<SkillProposal[]> {
    const entries = await readdir(this.pendingDir, { withFileTypes: true });
    const proposals: SkillProposal[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const proposal = await this.loadPendingProposal(entry.name);
      if (proposal) proposals.push(proposal);
    }
    return proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async loadPendingProposal(filename: string): Promise<SkillProposal | undefined> {
    const path = join(this.pendingDir, filename);
    try {
      const value = await this.readJson(path);
      if (!isRecord(value)) throw new Error("Invalid skill proposal.");
      return this.parseProposal(value, validateProposalId(filename.slice(0, -5)));
    } catch (error) {
      if (!isErrno(error, "ENOENT")) await this.quarantinePendingProposal(path, filename);
      return undefined;
    }
  }

  private async quarantinePendingProposal(path: string, filename: string): Promise<void> {
    try {
      await rename(path, join(this.invalidPendingDir, filename));
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }

  async pendingIndex(): Promise<string> {
    const pending = await this.listPending();
    if (pending.length === 0) return "(no pending project skill proposals)";
    const lines: string[] = [];
    let chars = 0;
    for (const proposal of pending) {
      const operation = proposal.operations.at(0);
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

  async approveProposal(id: string, assertedOrigin?: SkillWriteOrigin): Promise<SkillMutationResult> {
    const safeId = validateProposalId(id);
    return this.withLock(async () => {
      const path = join(this.pendingDir, `${safeId}.json`);
      const proposal = await this.readProposal(path, safeId);
      const operation = proposal.operations.at(0);
      const origin = proposal.origin ?? assertedOrigin ?? "background_review";
      if (proposal.origin && assertedOrigin && proposal.origin !== assertedOrigin) {
        throw new Error(
          `Skill proposal origin '${proposal.origin}' does not match caller approval origin '${assertedOrigin}'.`,
        );
      }
      if (!operation) {
        await unlink(path);
        return { changed: false, message: `Skill proposal '${safeId}' was empty.` };
      }
      if (operation.action === "create") {
        let current: ProjectSkill | undefined;
        try {
          current = await this.loadStoredSkill(operation.name);
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw error;
        }
        if (current) {
          let persistedReview: SkillReviewReceipt | undefined;
          try {
            persistedReview = parseSkillReviewReceipt(
              await this.readJson(join(this.skillsDir, current.name, SKILL_REVIEW_FILE)),
            );
          } catch (error) {
            if (!isErrno(error, "ENOENT")) throw error;
          }
          const recovered = proposal.review
            && persistedReview?.jobDigest === proposal.review.jobDigest
            && persistedReview.outcomeDigest === proposal.review.outcomeDigest
            && current.description === operation.description
            && current.content === operation.content;
          await unlink(path);
          return {
            changed: false,
            message: recovered
              ? `Recovered already-created project skill '${operation.name}' from its review receipt.`
              : `Discarded project skill proposal '${operation.name}': its target name now exists.`,
          };
        }
      }
      if (operation.action !== "create" && !proposal.binding) {
        await unlink(path);
        return {
          changed: false,
          message: `Discarded legacy unbound ${operation.action} proposal '${operation.name}' before mutation.`,
        };
      }
      if (operation.action !== "create" && proposal.binding) {
        let current: ProjectSkill;
        try {
          current = await this.loadStoredSkill(operation.name);
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw error;
          await unlink(path);
          return { changed: false, message: `Discarded project skill proposal '${operation.name}': its bound skill target is missing.` };
        }
        if (current.generationId !== proposal.binding.generationId) {
          await unlink(path);
          return { changed: false, message: `Discarded project skill proposal '${operation.name}': its bound skill generation changed.` };
        }
        if (projectSkillContentDigest(current) !== proposal.binding.contentDigest) {
          await unlink(path);
          return { changed: false, message: `Discarded project skill proposal '${operation.name}': its bound skill content changed.` };
        }
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
      try {
        const result = await this.applyOperation(operation, origin, safeId, proposal.review);
        if (result.changed && operation.action === "archive") {
          for (const pending of await this.listPending()) {
            if (pending.operations.at(0)?.name !== operation.name) continue;
            await unlink(join(this.pendingDir, `${pending.id}.json`)).catch((error) => {
              if (!isErrno(error, "ENOENT")) throw error;
            });
          }
        } else if (result.changed) {
          await unlink(path);
        }
        return result;
      } catch (error) {
        if (operation.action !== "patch" || !await this.invalidPatchResult(operation, origin === "background_review")) throw error;
        await unlink(path);
        return {
          changed: false,
          message: `Discarded invalid project skill proposal '${operation.name}'.`,
        };
      }
    });
  }

  /** Archives an active skill after an explicit foreground confirmation. */
  async archiveSkill(name: string, origin: SkillWriteOrigin = "foreground"): Promise<SkillMutationResult> {
    const skillName = validateSkillName(name);
    return this.withLock(async () => {
      const result = await this.applyOperation({ action: "archive", name: skillName }, origin, this.newProposalId());
      for (const proposal of await this.listPending()) {
        if (proposal.operations.at(0)?.name !== skillName) continue;
        await unlink(join(this.pendingDir, `${proposal.id}.json`));
      }
      return result;
    });
  }

  async rejectProposal(id: string): Promise<void> {
    const safeId = validateProposalId(id);
    await this.withLock(async () => {
      const path = join(this.pendingDir, `${safeId}.json`);
      const proposal = await this.readProposal(path, safeId);
      const operation = proposal.operations.at(0);
      if (proposal.retention && operation?.action === "archive" && proposal.binding) {
        let skill: ProjectSkill | undefined;
        try {
          skill = await this.loadSkill(operation.name);
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw error;
        }
        const bindingMatches = skill
          && skill.generationId === proposal.binding.generationId
          && projectSkillContentDigest(skill) === proposal.binding.contentDigest;
        if (skill && bindingMatches) {
          const completedCount = await this.activity.completedCount();
          await this.atomicWrite(join(this.skillsDir, skill.name, SKILL_FILE), renderSkillFile({
            ...skill,
            lastRetentionSession: completedCount,
            lastRetentionAt: this.timestamp(),
          }));
        }
      }
      await unlink(path);
    });
  }

  async pendingReviewEntryIds(sessionId: string): Promise<string[]> {
    const sessionKey = projectSkillSessionKey(sessionId);
    return this.withLock(async () => {
      const state = parseReviewState(await this.readJson(this.reviewPath));
      return (state.sessions[sessionKey]?.pending ?? []).map(({ entryId }) => entryId);
    });
  }

  async recordUserTurn(request: {
    sessionId: string;
    entryId: string;
    signalScore?: number;
  }): Promise<void> {
    if (!isRecord(request)) throw new Error("Invalid project skill review turn.");
    exactKeys(request, ["sessionId", "entryId"], ["signalScore"]);
    const sessionKey = projectSkillSessionKey(request.sessionId);
    const entryId = reviewEntryId(request.entryId);
    const signalScore = requireNonnegativeInteger(request.signalScore ?? 0, "project skill review signal score");
    if (signalScore > 5) throw new Error("Project skill review signal score exceeds 5.");
    await this.withLock(async () => {
      const state = parseReviewState(await this.readJson(this.reviewPath));
      const existing = state.sessions[sessionKey];
      const prior = existing?.pending.find((turn) => turn.entryId === entryId);
      if (prior) {
        if (prior.signalScore !== signalScore) throw new Error("Conflicting project skill review turn replay.");
        return;
      }
      const pendingCount = Object.values(state.sessions).reduce((sum, session) => sum + session.pending.length, 0);
      if (pendingCount >= MAX_SKILL_REVIEW_PENDING_TURNS) {
        throw new Error("Project skill review pending turn limit reached.");
      }
      if (!existing && Object.keys(state.sessions).length >= MAX_SKILL_REVIEW_SESSIONS) {
        throw new Error("Project skill review session limit reached.");
      }
      state.sessions[sessionKey] = {
        pending: [...(existing?.pending ?? []), { entryId, signalScore }],
      };
      await this.atomicWrite(this.reviewPath, state);
    });
  }

  async claimReviewIfDue(request: {
    sessionId: string;
    selectedEntryIds: readonly string[];
    eligibleEntryIds: readonly string[];
    interval?: number;
    signalThreshold?: number;
    force?: boolean;
  }): Promise<SkillReviewClaim | undefined> {
    if (!isRecord(request)) throw new Error("Invalid project skill review claim request.");
    exactKeys(request, ["sessionId", "selectedEntryIds", "eligibleEntryIds"], ["interval", "signalThreshold", "force"]);
    const sessionKey = projectSkillSessionKey(request.sessionId);
    const selectedEntryIds = reviewEntryIds(
      request.selectedEntryIds,
      "project skill review selected",
      MAX_SKILL_REVIEW_SELECTED_TURNS,
    );
    const eligibleEntryIds = reviewEntryIds(
      request.eligibleEntryIds,
      "project skill review eligible",
      MAX_SKILL_REVIEW_ELIGIBLE_TURNS,
    );
    const eligibleSet = new Set(eligibleEntryIds);
    if (selectedEntryIds.some((entryId) => !eligibleSet.has(entryId))) {
      throw new Error("Project skill review selected entry ids must be within eligible entry ids.");
    }
    const interval = request.interval === undefined
      ? DEFAULT_SKILL_REVIEW_INTERVAL
      : requireNonnegativeInteger(request.interval, "project skill review interval");
    const signalThreshold = request.signalThreshold === undefined
      ? DEFAULT_SKILL_REVIEW_SIGNAL_THRESHOLD
      : requireNonnegativeInteger(request.signalThreshold, "project skill review signal threshold");
    if (typeof request.force !== "undefined" && typeof request.force !== "boolean") {
      throw new Error("Invalid project skill review force flag.");
    }
    const force = request.force === true;
    return this.withLock(async () => {
      const state = parseReviewState(await this.readJson(this.reviewPath));
      const now = this.now();
      const lease = state.inFlightUntil ? new Date(state.inFlightUntil) : undefined;
      const next = state.nextAttemptAt ? new Date(state.nextAttemptAt) : undefined;
      if (lease && Number.isFinite(lease.getTime()) && lease > now) return undefined;
      if (!force && next && Number.isFinite(next.getTime()) && next > now) return undefined;
      const pending = state.sessions[sessionKey]?.pending ?? [];
      const eligible = pending.filter((turn) => eligibleSet.has(turn.entryId));
      const eligibleSignal = eligible.reduce((sum, turn) => sum + turn.signalScore, 0);
      if (!force && eligible.length < interval && eligibleSignal < signalThreshold) return undefined;
      const byId = new Map(pending.map((turn) => [turn.entryId, turn]));
      const captured = selectedEntryIds.flatMap((entryId) => {
        const turn = byId.get(entryId);
        return turn ? [turn] : [];
      });
      const generation = (state.generation ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) throw new Error("Project skill review generation exhausted.");
      const claim: SkillReviewClaim = {
        generation,
        token: randomUUID(),
        sessionKey,
        evidenceEntryIds: captured.map(({ entryId }) => entryId),
        capturedTurns: captured.length,
        capturedSignalScore: captured.reduce((sum, turn) => sum + turn.signalScore, 0),
      };
      state.generation = generation;
      state.activeClaim = claim;
      state.lastAttemptAt = now.toISOString();
      state.inFlightUntil = new Date(now.getTime() + SKILL_REVIEW_LEASE_MS).toISOString();
      await this.atomicWrite(this.reviewPath, state);
      return claim;
    });
  }

  async finishReview(request: { claim: SkillReviewClaim; outcome: SkillReviewOutcome }): Promise<boolean> {
    const settlement = parseReviewSettlement(request);
    return this.withLock(async () => {
      const state = parseReviewState(await this.readJson(this.reviewPath));
      const active = state.activeClaim;
      if (!active
        || active.generation !== settlement.claim.generation
        || active.token !== settlement.claim.token) return false;
      if (JSON.stringify(active) !== JSON.stringify(settlement.claim)) {
        throw new Error("Project skill review claim does not match its fenced capture.");
      }
      const now = this.now();
      if (settlement.outcome === "success") {
        const session = state.sessions[active.sessionKey];
        const captured = active.evidenceEntryIds.map((entryId) => session?.pending.find((turn) => turn.entryId === entryId));
        if (captured.some((turn) => !turn)
          || captured.reduce((sum, turn) => sum + (turn?.signalScore ?? 0), 0) !== active.capturedSignalScore) {
          throw new Error("Project skill review claim no longer matches pending evidence.");
        }
        if (session) {
          const consumed = new Set(active.evidenceEntryIds);
          const pending = session.pending.filter((turn) => !consumed.has(turn.entryId));
          if (pending.length > 0) state.sessions[active.sessionKey] = { pending };
          else delete state.sessions[active.sessionKey];
        }
        state.consecutiveFailures = 0;
        delete state.nextAttemptAt;
        state.lastReviewedAt = now.toISOString();
      } else if (settlement.outcome === "failure") {
        state.consecutiveFailures += 1;
        const delay = Math.min(
          SKILL_REVIEW_RETRY_MAX_MS,
          SKILL_REVIEW_RETRY_BASE_MS * (2 ** (state.consecutiveFailures - 1)),
        );
        state.nextAttemptAt = new Date(now.getTime() + delay).toISOString();
      }
      delete state.activeClaim;
      delete state.inFlightUntil;
      await this.atomicWrite(this.reviewPath, state);
      return true;
    });
  }

  private newProposalId(): string {
    return `${this.timestamp().replace(/[^0-9]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  }

  private createProposal(
    operations: SkillOperation[],
    sourceSessionId?: string,
    retention = false,
    retentionSession?: number,
    retentionAfterSessions?: number,
    binding?: SkillProposalBinding,
    origin?: SkillWriteOrigin,
    review?: SkillReviewReceipt,
  ): SkillProposal {
    const normalized = this.validateOperations(operations);
    return {
      version: SKILL_STORE_VERSION,
      id: this.newProposalId(),
      createdAt: this.timestamp(),
      ...(sourceSessionId ? { sourceSessionId } : {}),
      ...(origin ? { origin } : {}),
      ...(binding ? { binding } : {}),
      ...(review ? { review: parseSkillReviewReceipt(review) } : {}),
      ...(retention ? { retention: true } : {}),
      ...(retentionSession !== undefined ? { retentionSession } : {}),
      ...(retentionAfterSessions !== undefined ? { retentionAfterSessions } : {}),
      operations: normalized,
    };
  }

  private proposalBinding(skill: ProjectSkill): SkillProposalBinding {
    return { generationId: skill.generationId, contentDigest: projectSkillContentDigest(skill) };
  }

  private validateOperations(operations: SkillOperation[]): SkillOperation[] {
    if (operations.length > 1) throw new Error("A self-forming skill review may stage one operation at a time.");
    return operations.map((operation) => this.validateOperation(operation));
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
        action: "create",
        name,
        description: validateSkillDescription(operation.description || ""),
        content: validateSkillContent(operation.content || ""),
        ...metadata,
      };
    }
    if (operation.action === "patch") {
      const oldText = operation.oldText || "";
      if (!oldText.trim()) throw new Error("Skill patch requires oldText.");
      const newText = operation.newText ?? "";
      if (newText === oldText) throw new Error("Skill patch must change its matched text.");
      if (newText) validateSkillContent(newText);
      return { action: "patch", name, oldText, newText, ...metadata };
    }
    if (operation.action === "archive") return { action: "archive", name, ...metadata };
    throw new Error("Unknown skill operation.");
  }

  private async invalidPatchResult(operation: SkillOperation, generated = false): Promise<boolean> {
    const existing = await this.loadStoredSkill(operation.name);
    const oldText = operation.oldText!;
    const descriptionMatches = countOccurrences(existing.description, oldText);
    const contentMatches = countOccurrences(existing.content, oldText);
    if (descriptionMatches + contentMatches !== 1) return false;
    try {
      if (descriptionMatches === 1) {
        validateSkillDescription(existing.description.replace(oldText, operation.newText!));
      } else {
        const content = existing.content.replace(oldText, operation.newText!);
        if (generated) validateGeneratedSkillContent(content);
        else validateSkillContent(content);
      }
      return false;
    } catch {
      return true;
    }
  }

  private async applyOperation(
    operation: SkillOperation,
    origin: SkillWriteOrigin,
    proposalId: string,
    review?: SkillReviewReceipt,
  ): Promise<SkillMutationResult> {
    const validated = this.validateOperation(operation);
    const timestamp = this.timestamp();
    if (validated.action === "create") {
      if (origin === "background_review") validateGeneratedSkillContent(validated.content || "");
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
      if (review) await this.atomicWrite(join(this.skillsDir, skill.name, SKILL_REVIEW_FILE), review);
      await this.atomicWrite(path, renderSkillFile(skill));
      return { changed: true, message: `Created project skill '${skill.name}'.`, skill };
    }

    const existing = await this.loadSkill(validated.name);
    if (validated.action === "patch") {
      const oldText = validated.oldText!;
      const newText = validated.newText!;
      const descriptionMatches = countOccurrences(existing.description, oldText);
      const contentMatches = countOccurrences(existing.content, oldText);
      const matches = descriptionMatches + contentMatches;
      if (matches !== 1) throw new Error(`Skill patch text must match exactly once (found ${matches}).`);
      const nextContent = contentMatches === 1 ? existing.content.replace(oldText, newText) : undefined;
      const next: ProjectSkill = {
        ...existing,
        ...(descriptionMatches === 1
          ? { description: validateSkillDescription(existing.description.replace(oldText, newText)) }
          : { content: origin === "background_review"
            ? validateGeneratedSkillContent(nextContent || "")
            : validateSkillContent(nextContent || "") }),
        updatedAt: timestamp,
        updatedBy: origin,
        patchCount: existing.patchCount + 1,
        lastPatchedAt: timestamp,
      };
      await this.backupSkill(existing, proposalId, next, review);
      await this.atomicWrite(join(this.skillsDir, next.name, SKILL_FILE), renderSkillFile(next));
      if (review) await this.atomicWrite(join(this.skillsDir, next.name, SKILL_REVIEW_FILE), review);
      return { changed: true, message: `Patched project skill '${next.name}'.`, skill: next };
    }

    await this.backupSkill(existing, proposalId);
    const source = join(this.skillsDir, existing.name);
    if (review) await this.atomicWrite(join(source, SKILL_REVIEW_FILE), review);
    const target = join(
      this.archiveDir,
      `${existing.name}-${existing.generationId.slice(0, 12)}-${proposalId}`,
    );
    await rename(source, target);
    return { changed: true, message: `Archived project skill '${existing.name}'.`, skill: { ...existing, state: "archived" } };
  }

  private async backupSkill(
    skill: ProjectSkill,
    proposalId: string,
    expectedAfter?: ProjectSkill,
    review?: SkillReviewReceipt,
  ): Promise<void> {
    const revisionDir = join(this.revisionsDir, proposalId, skill.name);
    await this.atomicWrite(join(revisionDir, SKILL_FILE), renderSkillFile(skill));
    if (expectedAfter) {
      const metadata: SkillRevisionMetadata = {
        version: SKILL_REVISION_VERSION,
        generationId: skill.generationId,
        beforeDigest: skillRevisionDigest(skill),
        expectedAfterDigest: skillRevisionDigest(expectedAfter),
        ...(review ? { review: parseSkillReviewReceipt(review) } : {}),
      };
      await this.atomicWrite(join(revisionDir, SKILL_REVISION_FILE), metadata);
    }
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
        const operation = proposal.operations.at(0);
        if (!proposal.retention || operation?.action !== "archive" || operation.name !== name) continue;
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
    const origin = parseProposalOrigin(value.origin);
    const binding = parseProposalBinding(value.binding);
    const operations = value.operations.map((operation) => this.validateOperation(operation as SkillOperation));
    const review = value.review === undefined ? undefined : parseSkillReviewReceipt(value.review);
    if (review && (origin !== "background_review" || review.operationDigest !== skillOperationDigest(operations))) {
      throw new Error("Project skill review receipt does not bind its proposal.");
    }
    const operation = operations[0];
    if (review && (!operation || review.target.name !== operation.name)) {
      throw new Error("Project skill review receipt target does not bind its proposal.");
    }
    if (review && operation?.action === "create" && (binding || review.target.kind !== "absent")) {
      throw new Error("Project skill create receipt has an invalid target binding.");
    }
    if (review && operation && operation.action !== "create" && (!binding
      || review.target.kind !== "existing"
      || binding.generationId !== review.target.generationId
      || binding.contentDigest !== review.target.contentDigest)) {
      throw new Error("Project skill review receipt target binding is invalid.");
    }
    return {
      version: SKILL_STORE_VERSION,
      id,
      createdAt: typeof value.createdAt === "string" ? value.createdAt : this.timestamp(),
      ...(typeof value.sourceSessionId === "string" ? { sourceSessionId: value.sourceSessionId } : {}),
      ...(origin ? { origin } : {}),
      ...(binding ? { binding } : {}),
      ...(review ? { review } : {}),
      ...(value.retention === true ? { retention: true } : {}),
      ...(typeof value.retentionSession === "number" && Number.isInteger(value.retentionSession) && value.retentionSession >= 0 ? { retentionSession: value.retentionSession } : {}),
      ...(typeof value.retentionAfterSessions === "number" && Number.isInteger(value.retentionAfterSessions) && value.retentionAfterSessions > 0 ? { retentionAfterSessions: value.retentionAfterSessions } : {}),
      operations,
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
