import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { atomicWriteFile } from "./atomic-file.ts";

const VERSION = 1;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_LEGACY_BYTES = 5 * 1024 * 1024;
const MAX_SESSIONS = 100_000;
const MIGRATION_BATCH_SIZE = 100;
const SESSION_KEY = /^[0-9a-f]{32}$/u;
const GENERATION_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

type AtomicWriter = (path: string, content: string) => Promise<void>;

interface ActivityState {
  version: number;
  begunCount: number;
  completedCount: number;
}

interface SessionActivity {
  version: number;
  usedGenerationIds: string[];
  completedSequence?: number;
}

export interface GenerationUsage {
  version: number;
  useCount: number;
  useSessionCount: number;
  lastUsedCompletedSession?: number;
  lastUsedAt?: string;
}

interface JournalWrite {
  path: string;
  value: ActivityState | SessionActivity | GenerationUsage;
}

interface ActivityJournal {
  version: number;
  writes: JournalWrite[];
}

interface LegacyActivity {
  sessionIds: string[];
  completedIds: string[];
  usage: Record<string, unknown>;
}

interface LegacyUsageMaps {
  sessionUsage: Map<string, Set<string>>;
  generationSessions: Map<string, Set<string>>;
}

export interface LegacyGenerationSeed {
  useCount: number;
  useSessionCount?: number;
  lastUsedCompletedSession?: number;
  lastUsedAt?: string;
}

export interface ActivityInitialization {
  legacyPath?: string;
  generationAliases?: Record<string, string>;
  generationSeeds?: Record<string, LegacyGenerationSeed>;
}

interface ActivityOptions {
  writeFile?: AtomicWriter;
  now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}.`);
  return value as number;
}

function checkedIncrement(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) throw new Error(`${label} limit reached.`);
  return value + 1;
}

function validateGenerationId(value: string): string {
  if (!GENERATION_KEY.test(value) || value.length > 64) throw new Error("Invalid skill generation id.");
  return value;
}

function sessionKey(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized || normalized !== sessionId || normalized.length > 256) throw new Error("Invalid project skill session id.");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

function legacySessionKey(value: string): string {
  return SESSION_KEY.test(value) ? value : sessionKey(value);
}

function parseState(value: unknown): ActivityState {
  if (!isRecord(value) || value.version !== VERSION) throw new Error("Invalid skill activity state.");
  const begunCount = nonnegativeInteger(value.begunCount, "skill activity begun count");
  const completedCount = nonnegativeInteger(value.completedCount, "skill activity completion count");
  if (completedCount > begunCount || begunCount > MAX_SESSIONS) throw new Error("Invalid skill activity session counts.");
  return { version: VERSION, begunCount, completedCount };
}

function parseSession(value: unknown): SessionActivity {
  if (!isRecord(value) || value.version !== VERSION || !Array.isArray(value.usedGenerationIds)) {
    throw new Error("Invalid skill session activity.");
  }
  const usedGenerationIds = value.usedGenerationIds.map((id) => validateGenerationId(String(id)));
  if (new Set(usedGenerationIds).size !== usedGenerationIds.length) throw new Error("Duplicate skill session usage.");
  const completedSequence = value.completedSequence === undefined
    ? undefined
    : nonnegativeInteger(value.completedSequence, "skill session completion sequence");
  if (completedSequence !== undefined && completedSequence <= 0) throw new Error("Invalid skill session completion sequence.");
  return { version: VERSION, usedGenerationIds, ...(completedSequence ? { completedSequence } : {}) };
}

function parseGeneration(value: unknown): GenerationUsage {
  if (!isRecord(value) || value.version !== VERSION) throw new Error("Invalid skill generation activity.");
  const lastUsedAt = value.lastUsedAt === undefined
    ? undefined
    : typeof value.lastUsedAt === "string" && Number.isFinite(Date.parse(value.lastUsedAt))
      ? value.lastUsedAt
      : (() => { throw new Error("Invalid skill generation usage timestamp."); })();
  const lastUsedCompletedSession = value.lastUsedCompletedSession === undefined
    ? undefined
    : nonnegativeInteger(value.lastUsedCompletedSession, "skill generation last-used session");
  return {
    version: VERSION,
    useCount: nonnegativeInteger(value.useCount, "skill generation use count"),
    useSessionCount: nonnegativeInteger(value.useSessionCount, "skill generation session-use count"),
    ...(lastUsedCompletedSession ? { lastUsedCompletedSession } : {}),
    ...(lastUsedAt ? { lastUsedAt } : {}),
  };
}

function serialize(value: unknown): string {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_JSON_BYTES) throw new Error("Skill activity record exceeds size limit.");
  return content;
}

export class SkillActivityIndex {
  readonly root: string;
  readonly statePath: string;
  readonly sessionsDir: string;
  readonly generationsDir: string;
  readonly journalPath: string;

  private readonly writeFile: AtomicWriter;
  private readonly now: () => Date;

  constructor(projectDir: string, options: ActivityOptions = {}) {
    this.root = join(projectDir, "skill-activity-index");
    this.statePath = join(this.root, "state.json");
    this.sessionsDir = join(this.root, "sessions");
    this.generationsDir = join(this.root, "generations");
    this.journalPath = join(this.root, "journal.json");
    this.writeFile = options.writeFile ?? atomicWriteFile;
    this.now = options.now ?? (() => new Date());
  }

  async initialize(options: ActivityInitialization = {}): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.generationsDir, { recursive: true, mode: 0o700 });
    await this.recoverJournal();
    if (await this.exists(this.statePath)) {
      parseState(await this.readJson(this.statePath));
      if (options.legacyPath && await this.exists(options.legacyPath)) await this.archiveLegacy(options.legacyPath);
      return;
    }
    if (options.legacyPath && await this.exists(options.legacyPath)) {
      await this.migrateLegacy(options.legacyPath, options.generationAliases ?? {}, options.generationSeeds ?? {});
      return;
    }
    await this.writeJson(this.statePath, { version: VERSION, begunCount: 0, completedCount: 0 } satisfies ActivityState);
  }

  async beginSession(sessionId: string): Promise<{ isNew: boolean; completedCount: number }> {
    await this.recoverJournal();
    const state = await this.loadState();
    const path = this.sessionPath(sessionKey(sessionId));
    if (await this.exists(path)) return { isNew: false, completedCount: state.completedCount };
    if (state.begunCount >= MAX_SESSIONS) throw new Error("Project skill activity session limit reached.");
    await this.commit([
      { path: this.statePath, value: { ...state, begunCount: state.begunCount + 1 } },
      { path, value: { version: VERSION, usedGenerationIds: [] } satisfies SessionActivity },
    ]);
    return { isNew: true, completedCount: state.completedCount };
  }

  async recordUse(sessionId: string, generationId: string): Promise<GenerationUsage> {
    await this.recoverJournal();
    const key = sessionKey(sessionId);
    const generation = validateGenerationId(generationId);
    const state = await this.loadState();
    const sessionPath = this.sessionPath(key);
    const session = this.parseSessionForState(await this.readJson(sessionPath), state);
    const generationPath = this.generationPath(generation);
    const current = await this.loadGeneration(generation);
    const firstUse = !session.usedGenerationIds.includes(generation);
    const usedGenerationIds = firstUse ? [...session.usedGenerationIds, generation] : session.usedGenerationIds;
    const lastUsedCompletedSession = Math.max(
      current.lastUsedCompletedSession ?? 0,
      session.completedSequence ? state.completedCount : state.completedCount + 1,
    );
    const next: GenerationUsage = {
      version: VERSION,
      useCount: checkedIncrement(current.useCount, "Skill generation use count"),
      useSessionCount: firstUse
        ? checkedIncrement(current.useSessionCount, "Skill generation session-use count")
        : current.useSessionCount,
      lastUsedCompletedSession,
      lastUsedAt: this.now().toISOString(),
    };
    await this.commit([
      { path: sessionPath, value: { ...session, usedGenerationIds } },
      { path: generationPath, value: next },
    ]);
    return next;
  }

  async completeSession(sessionId: string): Promise<{ isNew: boolean; completedCount: number; usedGenerationIds: string[] }> {
    await this.recoverJournal();
    const key = sessionKey(sessionId);
    const state = await this.loadState();
    const path = this.sessionPath(key);
    const session = this.parseSessionForState(await this.readJson(path), state);
    if (session.completedSequence) {
      return { isNew: false, completedCount: state.completedCount, usedGenerationIds: session.usedGenerationIds };
    }
    const completedCount = checkedIncrement(state.completedCount, "Skill activity completion count");
    const writes: JournalWrite[] = [
      { path: this.statePath, value: { ...state, completedCount } },
      { path, value: { ...session, completedSequence: completedCount } },
    ];
    for (const generation of session.usedGenerationIds) {
      const usage = await this.loadGeneration(generation);
      writes.push({ path: this.generationPath(generation), value: { ...usage, lastUsedCompletedSession: completedCount } });
    }
    await this.commit(writes);
    return { isNew: true, completedCount, usedGenerationIds: session.usedGenerationIds };
  }

  async completedCount(): Promise<number> {
    return (await this.loadState()).completedCount;
  }

  async generationUsage(generationId: string): Promise<GenerationUsage> {
    return this.loadGeneration(validateGenerationId(generationId));
  }

  private parseSessionForState(value: unknown, state: ActivityState): SessionActivity {
    const session = parseSession(value);
    if (session.completedSequence !== undefined && session.completedSequence > state.completedCount) {
      throw new Error("Skill session completion sequence exceeds activity state.");
    }
    return session;
  }

  private async loadState(): Promise<ActivityState> {
    return parseState(await this.readJson(this.statePath));
  }

  private async loadGeneration(generationId: string): Promise<GenerationUsage> {
    const path = this.generationPath(generationId);
    if (!await this.exists(path)) return { version: VERSION, useCount: 0, useSessionCount: 0 };
    return parseGeneration(await this.readJson(path));
  }

  private async commit(writes: JournalWrite[]): Promise<void> {
    const journal: ActivityJournal = { version: VERSION, writes };
    await this.writeJson(this.journalPath, journal);
    await this.applyJournal(journal);
  }

  private async recoverJournal(): Promise<void> {
    if (!await this.exists(this.journalPath)) return;
    const value = await this.readJson(this.journalPath);
    if (!isRecord(value) || value.version !== VERSION || !Array.isArray(value.writes)) throw new Error("Invalid skill activity journal.");
    const writes: JournalWrite[] = value.writes.map((write) => this.validateJournalWrite(write));
    await this.applyJournal({ version: VERSION, writes });
  }

  private validateJournalWrite(value: unknown): JournalWrite {
    if (!isRecord(value) || typeof value.path !== "string") throw new Error("Invalid skill activity journal write.");
    const path = resolve(value.path);
    const relativePath = relative(resolve(this.root), path);
    if (!relativePath || relativePath.startsWith("..") || relativePath.startsWith("/")) {
      throw new Error("Invalid skill activity journal path.");
    }
    if (path === resolve(this.statePath)) return { path, value: parseState(value.value) };
    if (path.startsWith(`${resolve(this.sessionsDir)}/`)) return { path, value: parseSession(value.value) };
    if (path.startsWith(`${resolve(this.generationsDir)}/`)) return { path, value: parseGeneration(value.value) };
    throw new Error("Invalid skill activity journal destination.");
  }

  private async applyJournal(journal: ActivityJournal): Promise<void> {
    for (const write of journal.writes) await this.writeJson(write.path, write.value);
    try {
      await unlink(this.journalPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }

  private parseLegacyActivity(value: unknown): LegacyActivity {
    if (!isRecord(value) || value.version !== VERSION || !Array.isArray(value.sessionIds) || !isRecord(value.skillSessionIds)) {
      throw new Error("Invalid legacy skill activity state.");
    }
    if (!Number.isInteger(value.sessionCount) || value.sessionCount !== value.sessionIds.length || value.sessionIds.length > MAX_SESSIONS) {
      throw new Error("Invalid legacy skill activity session count.");
    }
    const sessionIds = value.sessionIds.map((id) => legacySessionKey(String(id)));
    if (new Set(sessionIds).size !== sessionIds.length) throw new Error("Duplicate legacy skill activity sessions.");
    const completedIds = Array.isArray(value.completedSessionIds) ? value.completedSessionIds.map((id) => legacySessionKey(String(id))) : [];
    const knownSessions = new Set(sessionIds);
    if (new Set(completedIds).size !== completedIds.length || completedIds.some((id) => !knownSessions.has(id))) {
      throw new Error("Invalid legacy completed session membership.");
    }
    return { sessionIds, completedIds, usage: value.skillSessionIds };
  }

  private mapLegacyUsage(
    activity: LegacyActivity,
    aliases: Record<string, string>,
  ): LegacyUsageMaps {
    const knownSessions = new Set(activity.sessionIds);
    const sessionUsage = new Map(activity.sessionIds.map((id) => [id, new Set<string>()]));
    const generationSessions = new Map<string, Set<string>>();
    for (const [legacyKey, ids] of Object.entries(activity.usage)) {
      if (!Array.isArray(ids)) throw new Error("Invalid legacy skill usage membership.");
      const generation = validateGenerationId(aliases[legacyKey] ?? legacyKey);
      const members = generationSessions.get(generation) ?? new Set<string>();
      for (const rawId of ids) {
        const id = legacySessionKey(String(rawId));
        if (!knownSessions.has(id)) throw new Error("Unknown legacy skill usage session.");
        members.add(id);
        sessionUsage.get(id)!.add(generation);
      }
      generationSessions.set(generation, members);
    }
    return { sessionUsage, generationSessions };
  }

  private legacySessionWrites(
    activity: LegacyActivity,
    sessionUsage: Map<string, Set<string>>,
  ): JournalWrite[] {
    const completion = new Map(activity.completedIds.map((id, index) => [id, index + 1]));
    return activity.sessionIds.map((id) => ({
      path: this.sessionPath(id),
      value: {
        version: VERSION,
        usedGenerationIds: [...(sessionUsage.get(id) ?? [])],
        ...(completion.has(id) ? { completedSequence: completion.get(id) } : {}),
      },
    }));
  }

  private legacyGenerationWrites(
    activity: LegacyActivity,
    generationSessions: Map<string, Set<string>>,
    seeds: Record<string, LegacyGenerationSeed>,
  ): JournalWrite[] {
    const completion = new Map(activity.completedIds.map((id, index) => [id, index + 1]));
    const generations = new Set([...generationSessions.keys(), ...Object.keys(seeds).map(validateGenerationId)]);
    return [...generations].map((generation) => {
      const members = [...(generationSessions.get(generation) ?? [])];
      const completed = members.map((id) => completion.get(id) ?? 0);
      const seed = seeds[generation];
      const lastUsedCompletedSession = Math.max(seed?.lastUsedCompletedSession ?? 0, ...completed, 0);
      return {
        path: this.generationPath(generation),
        value: {
          version: VERSION,
          useCount: Math.max(seed?.useCount ?? 0, members.length),
          useSessionCount: Math.max(seed?.useSessionCount ?? 0, members.length),
          ...(lastUsedCompletedSession ? { lastUsedCompletedSession } : {}),
          ...(seed?.lastUsedAt ? { lastUsedAt: seed.lastUsedAt } : {}),
        },
      };
    });
  }

  private async migrateLegacy(
    path: string,
    aliases: Record<string, string>,
    seeds: Record<string, LegacyGenerationSeed>,
  ): Promise<void> {
    const activity = this.parseLegacyActivity(await this.readLegacyJson(path));
    const usage = this.mapLegacyUsage(activity, aliases);
    const writes = [
      ...this.legacySessionWrites(activity, usage.sessionUsage),
      ...this.legacyGenerationWrites(activity, usage.generationSessions, seeds),
    ];
    for (let offset = 0; offset < writes.length; offset += MIGRATION_BATCH_SIZE) {
      await this.commit(writes.slice(offset, offset + MIGRATION_BATCH_SIZE));
    }
    await this.commit([{
      path: this.statePath,
      value: { version: VERSION, begunCount: activity.sessionIds.length, completedCount: activity.completedIds.length },
    }]);
    await this.archiveLegacy(path);
  }

  private async archiveLegacy(path: string): Promise<void> {
    try {
      await rename(path, `${path}.legacy`);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }

  private sessionPath(key: string): string {
    if (!SESSION_KEY.test(key)) throw new Error("Invalid skill activity session key.");
    return join(this.sessionsDir, `${key}.json`);
  }

  private generationPath(generationId: string): string {
    return join(this.generationsDir, `${validateGenerationId(generationId)}.json`);
  }

  private async readLegacyJson(path: string): Promise<unknown> {
    const info = await stat(path);
    if (info.size > MAX_LEGACY_BYTES) throw new Error(`Legacy skill activity exceeds ${MAX_LEGACY_BYTES} bytes: ${path}`);
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  }

  private async readJson(path: string): Promise<unknown> {
    const info = await stat(path);
    if (info.size > MAX_JSON_BYTES) throw new Error(`Skill activity record exceeds ${MAX_JSON_BYTES} bytes: ${path}`);
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await this.writeFile(path, serialize(value));
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
