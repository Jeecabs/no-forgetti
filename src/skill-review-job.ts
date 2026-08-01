import { createHash } from "node:crypto";

import { projectSkillSessionKey } from "./skill-activity.ts";
import {
  serializeSkillAuthorshipPromptPacket,
  type SkillAuthorshipPacket,
  type SkillAuthorshipPromptPacket,
} from "./skill-authorship-packet.ts";
import { buildSkillReviewPrompt, SKILL_REVIEWER_SYSTEM_PROMPT } from "./skill-authoring.ts";
import { SKILL_DOCTRINE } from "./skill-doctrine.ts";

const SKILL_REVIEW_JOB_VERSION = 1 as const;
const SKILL_REVIEW_PROMPT_VERSION = 1 as const;
const MAX_SKILL_REVIEW_JOB_BYTES = 128 * 1024;
const PROJECT_KEY = /^[0-9a-f]{24}$/u;

export interface SkillReviewJob {
  version: typeof SKILL_REVIEW_JOB_VERSION;
  kind: "project-skill-review";
  id: `skill_review_${string}`;
  digest: string;
  projectKey: string;
  sessionKey: string;
  claimGeneration: number;
  coverage: {
    frontierEntryId?: string;
    includedUserEntryIds: string[];
  };
  packet: SkillAuthorshipPromptPacket;
  contract: {
    promptVersion: typeof SKILL_REVIEW_PROMPT_VERSION;
    doctrineDigest: string;
    packetDigest: string;
    systemPromptDigest: string;
    initialPromptDigest: string;
    requestDigest: string;
    maxOperations: 1;
  };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function skillReviewRequestDigest(request: {
  promptVersion: number;
  systemPromptDigest: string;
  promptDigest: string;
}): string {
  return sha256(canonicalJson({
    promptVersion: request.promptVersion,
    systemPromptDigest: request.systemPromptDigest,
    promptDigest: request.promptDigest,
  }));
}

function clonedPromptPacket(packet: SkillAuthorshipPacket): SkillAuthorshipPromptPacket {
  return JSON.parse(serializeSkillAuthorshipPromptPacket(packet)) as SkillAuthorshipPromptPacket;
}

function promptContract(packet: SkillAuthorshipPromptPacket): SkillReviewJob["contract"] {
  const packetDigest = sha256(canonicalJson(packet as unknown as Json));
  const systemPromptDigest = sha256(SKILL_REVIEWER_SYSTEM_PROMPT);
  const initialPromptDigest = sha256(buildSkillReviewPrompt(packet));
  return {
    promptVersion: SKILL_REVIEW_PROMPT_VERSION,
    doctrineDigest: sha256(SKILL_DOCTRINE),
    packetDigest,
    systemPromptDigest,
    initialPromptDigest,
    requestDigest: skillReviewRequestDigest({
      promptVersion: SKILL_REVIEW_PROMPT_VERSION,
      systemPromptDigest,
      promptDigest: initialPromptDigest,
    }),
    maxOperations: 1,
  };
}

export function createSkillReviewJob(request: {
  projectKey: string;
  sessionId: string;
  claimGeneration: number;
  packet: SkillAuthorshipPacket;
}): Readonly<SkillReviewJob> {
  if (!PROJECT_KEY.test(request.projectKey)) throw new Error("Invalid project skill review project key.");
  if (!Number.isSafeInteger(request.claimGeneration) || request.claimGeneration < 1) {
    throw new Error("Invalid project skill review claim generation.");
  }
  const packet = clonedPromptPacket(request.packet);
  const core = {
    version: SKILL_REVIEW_JOB_VERSION,
    kind: "project-skill-review" as const,
    projectKey: request.projectKey,
    sessionKey: projectSkillSessionKey(request.sessionId),
    claimGeneration: request.claimGeneration,
    coverage: {
      ...(request.packet.coverage.frontierEntryId
        ? { frontierEntryId: request.packet.coverage.frontierEntryId }
        : {}),
      includedUserEntryIds: [...request.packet.coverage.includedUserEntryIds],
    },
    packet,
    contract: promptContract(packet),
  };
  const digest = sha256(canonicalJson(core as unknown as Json));
  const job: SkillReviewJob = {
    ...core,
    id: `skill_review_${digest.slice(0, 40)}`,
    digest,
  };
  const serialized = canonicalJson(job as unknown as Json);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SKILL_REVIEW_JOB_BYTES) {
    throw new Error(`Project skill review job exceeds ${MAX_SKILL_REVIEW_JOB_BYTES} bytes.`);
  }
  return deepFreeze(job) as Readonly<SkillReviewJob>;
}

export function serializeSkillReviewJob(job: Readonly<SkillReviewJob>): string {
  const serialized = canonicalJson(job as unknown as Json);
  if (job.version !== SKILL_REVIEW_JOB_VERSION || job.contract.promptVersion !== SKILL_REVIEW_PROMPT_VERSION) {
    throw new Error("Unsupported project skill review job prompt contract.");
  }
  if (canonicalJson(job.contract as unknown as Json) !== canonicalJson(promptContract(job.packet) as unknown as Json)) {
    throw new Error("Project skill review job prompt contract mismatch.");
  }
  if (sha256(canonicalJson({
    version: job.version,
    kind: job.kind,
    projectKey: job.projectKey,
    sessionKey: job.sessionKey,
    claimGeneration: job.claimGeneration,
    coverage: job.coverage,
    packet: job.packet,
    contract: job.contract,
  } as unknown as Json)) !== job.digest) {
    throw new Error("Project skill review job digest mismatch.");
  }
  if (job.id !== `skill_review_${job.digest.slice(0, 40)}`) throw new Error("Project skill review job id mismatch.");
  if (Buffer.byteLength(serialized, "utf8") > MAX_SKILL_REVIEW_JOB_BYTES) {
    throw new Error(`Project skill review job exceeds ${MAX_SKILL_REVIEW_JOB_BYTES} bytes.`);
  }
  return serialized;
}
