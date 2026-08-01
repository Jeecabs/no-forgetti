import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { buildReviewEvidenceWindow, type ReviewEvidenceCursorStatus } from "./review.ts";
import type { SkillConventionSnapshot } from "./skill-conventions.ts";
import { PROJECT_SKILL_USE_ENTRY } from "./skill-native.ts";
import {
  sanitizeSkillEvidenceText,
  validateSkillContent,
  validateSkillDescription,
  validateSkillMetadataText,
  validateSkillName,
} from "./skill-security.ts";
import { projectSkillContentDigest } from "./skill-content-digest.ts";
import type { ProjectSkillStore } from "./skill-store.ts";
import type { ProjectSkill, SkillOperation, SkillProposal } from "./skill-types.ts";
import { isRecord } from "./state-validation.ts";

const SKILL_AUTHORSHIP_PACKET_VERSION = 1 as const;
const MAX_SKILL_AUTHORSHIP_CATALOG_CHARS = 6_000;
const MAX_SKILL_AUTHORSHIP_CATALOG_ENTRIES = 128;
const MAX_SKILL_AUTHORSHIP_DOCUMENT_CHARS = 40_000;
const MAX_SKILL_AUTHORSHIP_DOCUMENTS = 8;
const MAX_SKILL_AUTHORSHIP_PENDING_CHARS = 6_000;
const MAX_SKILL_AUTHORSHIP_PENDING = 32;
const MAX_SKILL_AUTHORSHIP_PROMPT_CHARS = 96_000;
const MAX_ELIGIBLE_USER_ENTRY_IDS = 4_096;
const SAFE_ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_GENERATION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_PENDING_ID = /^\d{14}-[0-9a-f]{8}$/u;
const SAFE_OBSERVED_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const PROJECT_SKILL_PREFIX = "PROJECT SKILLS INVOKED: ";

const SEARCH_STOP_WORDS = new Set([
  "and", "are", "body", "check", "complete", "done", "for", "from", "into", "only", "procedure",
  "project", "run", "skill", "that", "the", "then", "this", "use", "when", "with", "workflow",
]);

export type SkillAuthorshipCorpusSource = Pick<ProjectSkillStore, "captureAuthorshipCorpus">;

export interface SkillAuthorshipPacket {
  version: typeof SKILL_AUTHORSHIP_PACKET_VERSION;
  kind: "skill-authorship";
  conventions: SkillConventionSnapshot;
  coverage: {
    frontierEntryId?: string;
    includedUserEntryIds: string[];
    /** Current branch/path scope used for cadence eligibility; never prompt-render this field. */
    eligibleUserEntryIds: string[];
    userTurns: number;
    truncated: boolean;
    cursorStatus: ReviewEvidenceCursorStatus;
  };
  evidence: {
    transcript: string;
    invokedSkillNames: string[];
    actions: SkillActionFact[];
    redactionCount: number;
  };
  corpus: {
    activeTotal: number;
    catalog: SkillAuthorshipCatalogEntry[];
    documents: SkillAuthorshipDocument[];
    catalogOmitted: number;
    documentsOmitted: number;
    pendingTotal: number;
    pending: SkillAuthorshipPending[];
    pendingOmitted: number;
    truncated: boolean;
  };
}

export type SkillActionFact =
  | { kind: "command"; command: string; outcome: "completed" | "failed" }
  | { kind: "path"; action: "read" | "write" | "edit"; path: string; outcome: "completed" | "failed" };

export interface SkillAuthorshipCatalogEntry {
  name: string;
  generationId: string;
  contentDigest: string;
  description: string;
  useCount: number;
  useSessionCount: number;
  patchCount: number;
  bodyAvailable: boolean;
}

export interface SkillAuthorshipDocument {
  name: string;
  generationId: string;
  patchCount: number;
  description: string;
  content: string;
}

export type SkillAuthorshipPromptPacket = Pick<
  SkillAuthorshipPacket,
  "version" | "kind" | "conventions" | "evidence" | "corpus"
>;

/** Prompt-safe projection: coverage IDs remain local control-plane data. */
function skillAuthorshipPromptPacket(packet: SkillAuthorshipPacket): SkillAuthorshipPromptPacket {
  return {
    version: packet.version,
    kind: packet.kind,
    conventions: packet.conventions,
    evidence: packet.evidence,
    corpus: packet.corpus,
  };
}

function promptPacketJson(packet: SkillAuthorshipPacket): string {
  return JSON.stringify(skillAuthorshipPromptPacket(packet), null, 2);
}

/** Exact bounded serialization consumed by the authorship prompt. */
export function serializeSkillAuthorshipPromptPacket(
  packet: SkillAuthorshipPacket | SkillAuthorshipPromptPacket,
): string {
  const serialized = "coverage" in packet
    ? promptPacketJson(packet)
    : JSON.stringify(packet, null, 2);
  if (serialized.length > MAX_SKILL_AUTHORSHIP_PROMPT_CHARS) {
    throw new Error(`Project skill authorship prompt packet exceeds ${MAX_SKILL_AUTHORSHIP_PROMPT_CHARS} characters.`);
  }
  return serialized;
}

export interface SkillAuthorshipPending {
  action: SkillOperation["action"];
  name: string;
  retention: boolean;
  reason?: string;
  description?: string;
}

interface RankedSkill {
  skill: ProjectSkill;
  catalog: Omit<SkillAuthorshipCatalogEntry, "bodyAvailable">;
  invokedAt: number;
  mentioned: boolean;
  overlap: number;
  exactDocument?: SkillAuthorshipDocument;
}

interface RankedPending {
  proposal: SkillProposal;
  summary: SkillAuthorshipPending;
  invokedAt: number;
  mentioned: boolean;
  overlap: number;
}

function safeEntryId(value: string, label: string): string {
  if (!SAFE_ENTRY_ID.test(value)) throw new Error(`Invalid project skill authorship ${label} entry id.`);
  return value;
}

function safeEntryIds(values: readonly string[], label: string, max: number): string[] {
  if (values.length > max) throw new Error(`Project skill authorship ${label} entry ids exceed ${max}.`);
  const ids = values.map((value) => safeEntryId(value, label));
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate project skill authorship ${label} entry id.`);
  return ids;
}

function safeGenerationId(value: string): string {
  if (!SAFE_GENERATION_ID.test(value)) throw new Error("Invalid project skill authorship generation id.");
  return value;
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function exactSafeDescription(value: string): string | undefined {
  try {
    const validated = validateSkillDescription(value);
    const sanitized = sanitizeSkillEvidenceText(value);
    return validated === value && sanitized.text === value && sanitized.redactionCount === 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function exactSafeContent(value: string): string | undefined {
  try {
    const validated = validateSkillContent(value);
    const sanitized = sanitizeSkillEvidenceText(value);
    return validated === value && sanitized.text === value && sanitized.redactionCount === 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function exactSafeMetadata(value: string): string | undefined {
  try {
    const validated = validateSkillMetadataText(value);
    const sanitized = sanitizeSkillEvidenceText(value);
    return validated === value && sanitized.text === value && sanitized.redactionCount === 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function exactSkillName(value: string): string | undefined {
  try {
    const validated = validateSkillName(value);
    return validated === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function exactGenerationId(value: string): string | undefined {
  try {
    return safeGenerationId(value);
  } catch {
    return undefined;
  }
}

function filterObservedNames(text: string): string {
  if (text.startsWith(PROJECT_SKILL_PREFIX)) {
    const names = text.slice(PROJECT_SKILL_PREFIX.length)
      .split(",")
      .map((name) => name.trim())
      .flatMap((name) => exactSkillName(name) ? [name] : []);
    return names.length > 0 ? `${PROJECT_SKILL_PREFIX}${names.join(", ")}` : "";
  }
  const toolResult = text.match(/^TOOL ([\s\S]*): (completed|failed)$/u);
  if (toolResult) {
    return SAFE_OBSERVED_NAME.test(toolResult[1]!) ? text : `TOOL [invalid]: ${toolResult[2]}`;
  }
  return text.replace(/\[tool call: ([^\]]*)\]/gu, (_match, name: string) => (
    SAFE_OBSERVED_NAME.test(name) ? `[tool call: ${name}]` : "[tool call: invalid]"
  ));
}

function selectedInvokedSkillNames(entries: readonly SessionEntry[], includedEntryIds: readonly string[]): string[] {
  const included = new Set(includedEntryIds);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!included.has(entry.id) || entry.type !== "custom" || entry.customType !== PROJECT_SKILL_USE_ENTRY) continue;
    const data: unknown = entry.data;
    if (!isRecord(data) || !Array.isArray(data.names)) continue;
    for (const value of data.names) {
      if (typeof value !== "string") continue;
      const name = exactSkillName(value);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

const SAFE_COMMAND_TOKEN = /^[A-Za-z0-9_./:@+=,-]+$/u;
const SAFE_SCRIPT_NAME = new Set(["test", "check", "lint", "build", "typecheck"]);
const MUTATING_COMMAND_FLAG = /^(?:--fix(?:-dry-run)?|--write|--output|-o|-w|-u|--updateSnapshot|--update-snapshots|--watch|--watchAll)(?:=.*)?$/u;
const SENSITIVE_COMMAND_OPTION = /^(?:--require|--loader|--import|--eval|-e|--env-file|--token|--password|--credential)(?:=|$)/iu;
const SECRET_PATH_SEGMENT = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.docker|\.kube|\.gnupg|\.npmrc|\.netrc|\.pypirc|\.yarnrc|\.pnpmrc|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx)|.*(?:credential|password|secret|token|private[-_]?key).*)$/iu;
const MAX_ACTION_FACTS = 32;
const MAX_ACTION_FACT_CHARS = 4_000;
const MAX_OBSERVED_TOOL_RECORDS = 128;
const MAX_RAW_ACTION_VALUE_CHARS = 1_024;

function commandTokenContainsSensitivePath(token: string): boolean {
  return token.split(/[=:,]/u).some((value) => (
    value.split(/[\\/]/u).some((segment) => SECRET_PATH_SEGMENT.test(segment))
  ));
}

function safeCommandTokens(tokens: readonly string[]): boolean {
  return tokens.length > 0 && tokens.every((token) => {
    if (!SAFE_COMMAND_TOKEN.test(token) || isAbsolute(token) || token.startsWith("~")) return false;
    if (/^[A-Za-z]:\//u.test(token) || /^file:\/\//iu.test(token)) return false;
    if (MUTATING_COMMAND_FLAG.test(token) || SENSITIVE_COMMAND_OPTION.test(token) || commandTokenContainsSensitivePath(token)) return false;
    const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
    if (isAbsolute(value) || value.startsWith("~") || /^[A-Za-z]:\//u.test(value) || /^file:\/\//iu.test(value)) return false;
    return !value.split(/[\\/]/u).includes("..");
  });
}

function safeVerifier(tokens: readonly string[]): boolean {
  const [executable, subcommand, target] = tokens;
  if (executable === "node") return subcommand === "--test" || Boolean(subcommand?.startsWith("--test="));
  if (executable === "tsc") return tokens.includes("--noEmit");
  if (executable === "eslint") return tokens.length >= 2;
  if (executable === "vitest") return subcommand === "run";
  if (executable === "jest" || executable === "pytest") return true;
  if (executable === "python" || executable === "python3") return subcommand === "-m" && target === "pytest";
  if (executable === "uv") {
    return subcommand === "run" && (target === "pytest" || (target === "python" && tokens[3] === "-m" && tokens[4] === "pytest"));
  }
  if (executable === "make" || executable === "just") return SAFE_SCRIPT_NAME.has(subcommand ?? "");
  if (executable === "git") return ["status", "diff", "log", "show", "rev-parse", "grep"].includes(subcommand ?? "");
  if (executable === "cargo") return ["test", "check", "clippy", "build"].includes(subcommand ?? "");
  if (executable === "go") return ["test", "vet", "build"].includes(subcommand ?? "");
  return false;
}

function safeCommandProduction(tokens: readonly string[]): boolean {
  const [executable] = tokens;
  if (!["pnpm", "npm", "yarn", "bun"].includes(executable ?? "")) return safeVerifier(tokens);
  let cursor = 1;
  if (tokens[cursor] === "--filter") {
    if (!tokens[cursor + 1] || tokens[cursor + 1]!.startsWith("-")) return false;
    cursor += 2;
  }
  if (tokens[cursor] === "exec") return safeVerifier(tokens.slice(cursor + 1));
  if (tokens[cursor] === "run") cursor += 1;
  return SAFE_SCRIPT_NAME.has(tokens[cursor] ?? "");
}

function safeVerificationCommand(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_RAW_ACTION_VALUE_CHARS) return undefined;
  if (/[\u0000-\u0008\u000A-\u001F\u007F]/u.test(value)) return undefined;
  const normalized = value.replace(/[ \t]+/gu, " ").replace(/^ | $/gu, "");
  if (!normalized || sanitizeSkillEvidenceText(normalized).redactionCount > 0) return undefined;
  if (/["'`$|;<>\\]/u.test(normalized)) return undefined;
  const segments = normalized.split(" && ");
  if (segments.some((segment) => !segment)) return undefined;
  for (const segment of segments) {
    const tokens = segment.split(" ");
    if (!safeCommandTokens(tokens) || !safeCommandProduction(tokens)) return undefined;
  }
  return normalized;
}

function containedPath(root: string, candidate: string): boolean {
  const local = relative(root, candidate);
  return local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}

async function nearestExistingRealpath(value: string, boundary: string): Promise<string | undefined> {
  let current = value;
  while (containedPath(boundary, current)) {
    try {
      return await realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    if (current === boundary) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

async function safeProjectPath(value: unknown, projectRoot: string): Promise<string | undefined> {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_RAW_ACTION_VALUE_CHARS) return undefined;
  if (/[\u0000-\u001F\u007F]/u.test(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^file:\/\//iu.test(value) || value.startsWith("~")) return undefined;
  const root = resolve(projectRoot);
  const absolute = resolve(root, value);
  if (!containedPath(root, absolute) || absolute === root) return undefined;
  const local = relative(root, absolute);
  const normalized = local.split(sep).join("/");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || SECRET_PATH_SEGMENT.test(segment))) {
    return undefined;
  }
  if (sanitizeSkillEvidenceText(normalized).redactionCount > 0) return undefined;
  try {
    const canonicalRoot = await realpath(root);
    const canonicalTarget = await nearestExistingRealpath(absolute, root);
    if (!canonicalTarget || !containedPath(canonicalRoot, canonicalTarget)) return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
  }
  return normalized;
}

interface ObservedToolCall {
  order: number;
  name: string;
  arguments: Record<string, unknown>;
}

interface ObservedToolResult {
  order: number;
  name: string;
  failed: boolean;
}

async function selectedActionFacts(
  entries: readonly SessionEntry[],
  includedEntryIds: readonly string[],
  projectRoot?: string,
): Promise<SkillActionFact[]> {
  if (!projectRoot) return [];
  const included = new Set(includedEntryIds);
  const calls = new Map<string, ObservedToolCall[]>();
  const results = new Map<string, ObservedToolResult[]>();
  let callCount = 0;
  let resultCount = 0;
  let order = 0;
  for (const entry of entries) {
    if (!included.has(entry.id) || entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        order += 1;
        if (part.type !== "toolCall" || !isRecord(part.arguments) || part.id.length > 256) continue;
        callCount += 1;
        if (callCount > MAX_OBSERVED_TOOL_RECORDS) return [];
        const observed = calls.get(part.id) ?? [];
        observed.push({ order, name: part.name, arguments: part.arguments });
        calls.set(part.id, observed);
      }
      continue;
    }
    if (message.role !== "toolResult" || message.toolCallId.length > 256) continue;
    order += 1;
    resultCount += 1;
    if (resultCount > MAX_OBSERVED_TOOL_RECORDS) return [];
    const observed = results.get(message.toolCallId) ?? [];
    observed.push({ order, name: message.toolName, failed: message.isError });
    results.set(message.toolCallId, observed);
  }

  const pairs = [...calls.entries()].flatMap(([id, callList]) => {
    const resultList = results.get(id) ?? [];
    if (callList.length !== 1 || resultList.length !== 1) return [];
    const call = callList[0]!;
    const result = resultList[0]!;
    return result.order > call.order && result.name === call.name ? [{ call, result }] : [];
  }).sort((left, right) => left.call.order - right.call.order);

  const facts: SkillActionFact[] = [];
  const seen = new Set<string>();
  for (const { call, result } of pairs) {
    const outcome = result.failed ? "failed" : "completed";
    let fact: SkillActionFact | undefined;
    if (call.name === "bash") {
      const command = safeVerificationCommand(call.arguments.command);
      if (command) fact = { kind: "command", command, outcome };
    } else if (call.name === "read" || call.name === "write" || call.name === "edit") {
      const path = await safeProjectPath(call.arguments.path, projectRoot);
      if (path) fact = { kind: "path", action: call.name, path, outcome };
    }
    if (!fact) continue;
    const identity = JSON.stringify(fact);
    if (seen.has(identity)) continue;
    const candidate = [...facts, fact];
    if (candidate.length > MAX_ACTION_FACTS || JSON.stringify(candidate, null, 2).length > MAX_ACTION_FACT_CHARS) continue;
    seen.add(identity);
    facts.push(fact);
  }
  return facts;
}

function includedUserEntryIds(entries: readonly SessionEntry[], includedEntryIds: readonly string[]): string[] {
  const roles = new Map<string, boolean>();
  for (const entry of entries) {
    if (roles.has(entry.id)) throw new Error("Duplicate project skill authorship session entry id.");
    roles.set(entry.id, entry.type === "message" && entry.message.role === "user");
  }
  return includedEntryIds.flatMap((id) => roles.get(id) ? [id] : []);
}

function searchTokens(value: string): Set<string> {
  const tokens = value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(tokens.filter((token) => token.length >= 3 && !SEARCH_STOP_WORDS.has(token)));
}

function tokenOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function mentionedName(evidence: string, name: string): boolean {
  const words = evidence.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const target = name.toLowerCase().split("-");
  return words.some((_word, index) => target.every((part, offset) => words[index + offset] === part));
}

function rankingComparator<T extends { invokedAt: number; mentioned: boolean; overlap: number }>(
  name: (value: T) => string,
  usage: (value: T) => number,
): (left: T, right: T) => number {
  return (left, right) => (
    left.invokedAt - right.invokedAt
    || Number(right.mentioned) - Number(left.mentioned)
    || right.overlap - left.overlap
    || usage(right) - usage(left)
    || name(left).localeCompare(name(right))
  );
}

function rankedSkills(skills: readonly ProjectSkill[], transcript: string, invokedNames: readonly string[]): RankedSkill[] {
  const invoked = new Map(invokedNames.map((name, index) => [name, index]));
  const evidenceTokens = searchTokens(transcript);
  const seenNames = new Set<string>();
  const ranked: RankedSkill[] = [];
  for (const skill of skills) {
    const name = exactSkillName(skill.name);
    if (!name || seenNames.has(name)) continue;
    seenNames.add(name);
    const generationId = exactGenerationId(skill.generationId);
    const description = exactSafeDescription(skill.description);
    if (!generationId || !description) continue;
    const catalog = {
      name,
      generationId,
      contentDigest: projectSkillContentDigest(skill),
      description,
      useCount: safeCount(skill.useCount),
      useSessionCount: safeCount(skill.useSessionCount),
      patchCount: safeCount(skill.patchCount),
    };
    const content = exactSafeContent(skill.content);
    ranked.push({
      skill,
      catalog,
      invokedAt: invoked.get(name) ?? Number.MAX_SAFE_INTEGER,
      mentioned: mentionedName(transcript, name),
      overlap: tokenOverlap(evidenceTokens, searchTokens(`${name} ${description}`)),
      ...(content ? { exactDocument: { name, generationId, patchCount: catalog.patchCount, description, content } } : {}),
    });
  }
  return ranked.sort(rankingComparator((value) => value.catalog.name, (value) => value.catalog.useSessionCount));
}

function packJson<T>(values: readonly T[], maxEntries: number, maxChars: number): T[] {
  const selected: T[] = [];
  for (const value of values) {
    if (selected.length >= maxEntries) break;
    const candidate = [...selected, value];
    if (JSON.stringify(candidate, null, 2).length > maxChars) continue;
    selected.push(value);
  }
  return selected;
}

function safePendingSummary(proposal: SkillProposal): SkillAuthorshipPending | undefined {
  const operation = proposal.operations.at(0);
  if (!operation || proposal.operations.length !== 1) return undefined;
  if (operation.action !== "create" && operation.action !== "patch" && operation.action !== "archive") return undefined;
  if (!SAFE_PENDING_ID.test(proposal.id)) return undefined;
  const name = exactSkillName(operation.name);
  if (!name) return undefined;
  const reason = operation.reason === undefined ? undefined : exactSafeMetadata(operation.reason);
  if (operation.reason !== undefined && !reason) return undefined;
  const description = operation.action === "create" && operation.description !== undefined
    ? exactSafeDescription(operation.description)
    : undefined;
  if (operation.action === "create" && !description) return undefined;
  return {
    action: operation.action,
    name,
    retention: proposal.retention === true,
    ...(reason ? { reason } : {}),
    ...(description ? { description } : {}),
  };
}

function rankedPending(
  proposals: readonly SkillProposal[],
  transcript: string,
  invokedNames: readonly string[],
): RankedPending[] {
  const invoked = new Map(invokedNames.map((name, index) => [name, index]));
  const evidenceTokens = searchTokens(transcript);
  return proposals.flatMap((proposal): RankedPending[] => {
    const summary = safePendingSummary(proposal);
    if (!summary) return [];
    const searchable = `${summary.name} ${summary.description ?? ""} ${summary.reason ?? ""}`;
    return [{
      proposal,
      summary,
      invokedAt: invoked.get(summary.name) ?? Number.MAX_SAFE_INTEGER,
      mentioned: mentionedName(transcript, summary.name),
      overlap: tokenOverlap(evidenceTokens, searchTokens(searchable)),
    }];
  }).sort((left, right) => (
    rankingComparator<RankedPending>((value) => value.summary.name, () => 0)(left, right)
    || left.proposal.createdAt.localeCompare(right.proposal.createdAt)
    || left.proposal.id.localeCompare(right.proposal.id)
  ));
}

function refreshCorpusMetadata(packet: SkillAuthorshipPacket, signaledDocuments: number): void {
  const available = new Set(packet.corpus.documents.map((document) => document.name));
  packet.corpus.catalog = packet.corpus.catalog.map((entry) => ({
    ...entry,
    bodyAvailable: available.has(entry.name),
  }));
  packet.corpus.catalogOmitted = packet.corpus.activeTotal - packet.corpus.catalog.length;
  packet.corpus.documentsOmitted = signaledDocuments - packet.corpus.documents.length;
  packet.corpus.pendingOmitted = packet.corpus.pendingTotal - packet.corpus.pending.length;
  packet.corpus.truncated = packet.corpus.catalogOmitted > 0
    || packet.corpus.documentsOmitted > 0
    || packet.corpus.pendingOmitted > 0;
}

function fitPromptSerialization(packet: SkillAuthorshipPacket, signaledDocuments: number): SkillAuthorshipPacket {
  refreshCorpusMetadata(packet, signaledDocuments);
  while (promptPacketJson(packet).length > MAX_SKILL_AUTHORSHIP_PROMPT_CHARS) {
    if (packet.corpus.pending.length > 0) {
      packet.corpus.pending.pop();
    } else {
      let catalogOnly = -1;
      for (let index = packet.corpus.catalog.length - 1; index >= 0; index -= 1) {
        if (!packet.corpus.catalog[index]!.bodyAvailable) {
          catalogOnly = index;
          break;
        }
      }
      if (catalogOnly >= 0) {
        packet.corpus.catalog.splice(catalogOnly, 1);
      } else if (packet.corpus.documents.length > 0) {
        packet.corpus.documents.pop();
      } else if (packet.corpus.catalog.length > 0) {
        packet.corpus.catalog.pop();
      } else {
        throw new Error(`Project skill authorship evidence exceeds ${MAX_SKILL_AUTHORSHIP_PROMPT_CHARS} characters.`);
      }
    }
    refreshCorpusMetadata(packet, signaledDocuments);
  }
  return packet;
}

export async function buildSkillAuthorshipPacket(request: {
  entries: readonly SessionEntry[];
  afterEntryId?: string;
  pendingReviewEntryIds?: readonly string[];
  projectRoot?: string;
  conventions?: SkillConventionSnapshot;
  store: SkillAuthorshipCorpusSource;
}): Promise<SkillAuthorshipPacket> {
  const sanitizedSection = (section: string) => sanitizeSkillEvidenceText(filterObservedNames(section));
  const window = buildReviewEvidenceWindow(request.entries, request.afterEntryId, {
    sanitizeText: (section) => sanitizedSection(section).text,
    countSanitizations: (section) => sanitizedSection(section).redactionCount,
  });
  const selectedUserIds = safeEntryIds(
    includedUserEntryIds(request.entries, window.includedEntryIds),
    "included user",
    12,
  );
  const selectedSet = new Set(selectedUserIds);
  const pendingSet = request.pendingReviewEntryIds ? new Set(request.pendingReviewEntryIds) : undefined;
  const eligibleUserIds = safeEntryIds(
    pendingSet
      ? window.eligibleUserEntryIds.filter((entryId) => selectedSet.has(entryId) || pendingSet.has(entryId))
      : window.eligibleUserEntryIds,
    "eligible user",
    MAX_ELIGIBLE_USER_ENTRY_IDS,
  );
  const frontierEntryId = window.throughEntryId === undefined
    ? undefined
    : safeEntryId(window.throughEntryId, "frontier");
  const invokedNames = selectedInvokedSkillNames(request.entries, window.includedEntryIds);
  const { skills, pending: proposals } = await request.store.captureAuthorshipCorpus();
  const ranked = rankedSkills(skills, window.transcript, invokedNames);

  const preliminaryCatalog = packJson(
    ranked.map((value): SkillAuthorshipCatalogEntry => ({ ...value.catalog, bodyAvailable: false })),
    MAX_SKILL_AUTHORSHIP_CATALOG_ENTRIES,
    MAX_SKILL_AUTHORSHIP_CATALOG_CHARS,
  );
  const catalogNames = new Set(preliminaryCatalog.map((value) => value.name));
  const signaledDocuments = ranked.filter((value) => (
    catalogNames.has(value.catalog.name)
    && (value.invokedAt !== Number.MAX_SAFE_INTEGER || value.mentioned || value.overlap > 0)
  ));
  const relevantDocuments = signaledDocuments.flatMap((value) => value.exactDocument ? [value.exactDocument] : []);
  const documents = packJson(
    relevantDocuments,
    MAX_SKILL_AUTHORSHIP_DOCUMENTS,
    MAX_SKILL_AUTHORSHIP_DOCUMENT_CHARS,
  );
  const documentNames = new Set(documents.map((value) => value.name));
  const catalog = preliminaryCatalog.map((value) => ({ ...value, bodyAvailable: documentNames.has(value.name) }));
  const pending = packJson(
    rankedPending(proposals, window.transcript, invokedNames).map((value) => value.summary),
    MAX_SKILL_AUTHORSHIP_PENDING,
    MAX_SKILL_AUTHORSHIP_PENDING_CHARS,
  );
  const catalogOmitted = skills.length - catalog.length;
  const documentsOmitted = signaledDocuments.length - documents.length;
  const pendingOmitted = proposals.length - pending.length;

  return fitPromptSerialization({
    version: SKILL_AUTHORSHIP_PACKET_VERSION,
    kind: "skill-authorship",
    conventions: request.conventions ?? { memory: [] },
    coverage: {
      ...(frontierEntryId ? { frontierEntryId } : {}),
      includedUserEntryIds: selectedUserIds,
      eligibleUserEntryIds: eligibleUserIds,
      userTurns: window.userTurns,
      truncated: window.truncated,
      cursorStatus: window.cursorStatus,
    },
    evidence: {
      transcript: window.transcript,
      invokedSkillNames: invokedNames,
      actions: await selectedActionFacts(request.entries, window.includedEntryIds, request.projectRoot),
      redactionCount: window.sanitizationCount,
    },
    corpus: {
      activeTotal: skills.length,
      catalog,
      documents,
      catalogOmitted,
      documentsOmitted,
      pendingTotal: proposals.length,
      pending,
      pendingOmitted,
      truncated: catalogOmitted > 0 || documentsOmitted > 0 || pendingOmitted > 0,
    },
  }, signaledDocuments.length);
}
