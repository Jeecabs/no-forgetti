import { createHash } from "node:crypto";

import type { SkillReviewExecutionOutcome } from "./skill-review-engine.ts";
import { skillReviewRequestDigest, type SkillReviewJob } from "./skill-review-job.ts";
import type {
  SkillOperation,
  SkillReviewAttemptReceipt,
  SkillReviewerProfileReceipt,
  SkillReviewReceipt,
  SkillReviewTargetReceipt,
} from "./skill-types.ts";
import { exactKeys, isRecord } from "./state-validation.ts";

const DIGEST = /^[0-9a-f]{64}$/u;
const JOB_ID = /^skill_review_[0-9a-f]{40}$/u;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
}

function digest(value: Json): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new Error(`Invalid project skill review ${label}.`);
  }
  return value;
}

function hex(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`Invalid project skill review ${label}.`);
  return value;
}

function nonnegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid project skill review ${label}.`);
  return value;
}

function tokens(value: unknown, label: string): number {
  const parsed = nonnegative(value, label);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid project skill review ${label}.`);
  return parsed;
}

function iso(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(parsed)) {
    throw new Error(`Invalid project skill review ${label}.`);
  }
  return parsed;
}

export function skillOperationDigest(operations: readonly SkillOperation[]): string {
  return digest(operations as unknown as Json);
}

function profileDigest(profile: Omit<SkillReviewerProfileReceipt, "digest">): string {
  return digest(profile as unknown as Json);
}

export interface RequestedSkillReviewerProfile {
  provider: string;
  model: string;
  api: string;
  reasoningEffort: string;
  maxOutputTokens?: number;
}

export function createSkillReviewReceipt(request: {
  job: Readonly<SkillReviewJob>;
  outcome: SkillReviewExecutionOutcome;
  profile: RequestedSkillReviewerProfile;
}): SkillReviewReceipt {
  const { job, outcome } = request;
  if (outcome.disposition !== "proposed" || outcome.jobId !== job.id || outcome.jobDigest !== job.digest) {
    throw new Error("Cannot bind non-proposal project skill review outcome.");
  }
  const profileCore = {
    provider: text(request.profile.provider, "profile provider"),
    model: text(request.profile.model, "profile model"),
    api: text(request.profile.api, "profile API"),
    reasoningEffort: text(request.profile.reasoningEffort, "profile reasoning effort", 32),
    ...(request.profile.maxOutputTokens === undefined ? {} : {
      maxOutputTokens: tokens(request.profile.maxOutputTokens, "profile max output tokens"),
    }),
  };
  const profile: SkillReviewerProfileReceipt = { digest: profileDigest(profileCore), ...profileCore };
  const attempts = outcome.attempts.map((attempt): SkillReviewAttemptReceipt => ({
    ordinal: attempt.ordinal,
    promptDigest: attempt.promptDigest,
    requestDigest: attempt.requestDigest,
    outputDigest: attempt.outputDigest,
    invalidOutput: attempt.validationErrorCode === "invalid_output",
    provider: attempt.provenance.provider,
    model: attempt.provenance.model,
    api: attempt.provenance.api,
    ...(attempt.provenance.responseModel ? { responseModel: attempt.provenance.responseModel } : {}),
    ...(attempt.provenance.responseId ? { responseId: attempt.provenance.responseId } : {}),
    startedAt: attempt.provenance.startedAt,
    completedAt: attempt.provenance.completedAt,
    durationMs: attempt.provenance.durationMs,
    inputTokens: attempt.provenance.usage.input,
    outputTokens: attempt.provenance.usage.output,
    totalTokens: attempt.provenance.usage.totalTokens,
    costTotal: attempt.provenance.usage.cost.total,
  }));
  const operation = outcome.plan.operations[0];
  if (!operation) throw new Error("Cannot bind an empty project skill review proposal.");
  const catalogTarget = job.packet.corpus.catalog.find(({ name }) => name === operation.name);
  const target: SkillReviewTargetReceipt = operation.action === "create"
    ? { kind: "absent", name: operation.name }
    : catalogTarget
      ? {
        kind: "existing",
        name: operation.name,
        generationId: catalogTarget.generationId,
        contentDigest: catalogTarget.contentDigest,
      }
      : (() => { throw new Error("Project skill review target is absent from its captured corpus."); })();
  const operationDigest = skillOperationDigest(outcome.plan.operations);
  const outcomeDigest = digest({
    disposition: "proposed",
    jobId: outcome.jobId,
    jobDigest: outcome.jobDigest,
    operationDigest,
    target,
    attempts,
  } as unknown as Json);
  const core = {
    version: 1 as const,
    jobId: job.id,
    jobDigest: job.digest,
    promptVersion: job.contract.promptVersion,
    systemPromptDigest: job.contract.systemPromptDigest,
    initialPromptDigest: job.contract.initialPromptDigest,
    requestDigest: job.contract.requestDigest,
    operationDigest,
    target,
    outcomeDigest,
    profile,
    attempts,
  };
  return parseSkillReviewReceipt({
    ...core,
    receiptDigest: digest(core as unknown as Json),
  });
}

function parseProfile(value: unknown): SkillReviewerProfileReceipt {
  if (!isRecord(value)) throw new Error("Invalid project skill review profile.");
  exactKeys(value, ["digest", "provider", "model", "api", "reasoningEffort"], ["maxOutputTokens"]);
  const core = {
    provider: text(value.provider, "profile provider"),
    model: text(value.model, "profile model"),
    api: text(value.api, "profile API"),
    reasoningEffort: text(value.reasoningEffort, "profile reasoning effort", 32),
    ...(value.maxOutputTokens === undefined ? {} : {
      maxOutputTokens: tokens(value.maxOutputTokens, "profile max output tokens"),
    }),
  };
  const parsed = { digest: hex(value.digest, "profile digest"), ...core };
  if (parsed.digest !== profileDigest(core)) throw new Error("Project skill review profile digest mismatch.");
  return parsed;
}

function parseTarget(value: unknown): SkillReviewTargetReceipt {
  if (!isRecord(value)) throw new Error("Invalid project skill review target binding.");
  if (value.kind === "absent") {
    exactKeys(value, ["kind", "name"]);
    const name = text(value.name, "target name", 64);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) throw new Error("Invalid project skill review target name.");
    return { kind: "absent", name };
  }
  exactKeys(value, ["kind", "name", "generationId", "contentDigest"]);
  if (value.kind !== "existing") throw new Error("Invalid project skill review target kind.");
  const name = text(value.name, "target name", 64);
  const generationId = text(value.generationId, "target generation", 128);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(generationId)) {
    throw new Error("Invalid project skill review target identity.");
  }
  return {
    kind: "existing",
    name,
    generationId,
    contentDigest: hex(value.contentDigest, "target content digest"),
  };
}

function parseAttempt(value: unknown, expectedOrdinal: number): SkillReviewAttemptReceipt {
  if (!isRecord(value)) throw new Error("Invalid project skill review attempt.");
  exactKeys(value, [
    "ordinal", "promptDigest", "requestDigest", "outputDigest", "invalidOutput", "provider", "model", "api", "startedAt", "completedAt",
    "durationMs", "inputTokens", "outputTokens", "totalTokens", "costTotal",
  ], ["responseModel", "responseId"]);
  if (value.ordinal !== expectedOrdinal || typeof value.invalidOutput !== "boolean") {
    throw new Error("Invalid project skill review attempt ordinal or status.");
  }
  return {
    ordinal: expectedOrdinal,
    promptDigest: hex(value.promptDigest, "attempt prompt digest"),
    requestDigest: hex(value.requestDigest, "attempt request digest"),
    outputDigest: hex(value.outputDigest, "attempt output digest"),
    invalidOutput: value.invalidOutput === true,
    provider: text(value.provider, "attempt provider"),
    model: text(value.model, "attempt model"),
    api: text(value.api, "attempt API"),
    ...(value.responseModel === undefined ? {} : { responseModel: text(value.responseModel, "attempt response model") }),
    ...(value.responseId === undefined ? {} : { responseId: text(value.responseId, "attempt response id") }),
    startedAt: iso(value.startedAt, "attempt start"),
    completedAt: iso(value.completedAt, "attempt completion"),
    durationMs: nonnegative(value.durationMs, "attempt duration"),
    inputTokens: tokens(value.inputTokens, "attempt input tokens"),
    outputTokens: tokens(value.outputTokens, "attempt output tokens"),
    totalTokens: tokens(value.totalTokens, "attempt total tokens"),
    costTotal: nonnegative(value.costTotal, "attempt cost"),
  };
}

export function parseSkillReviewReceipt(value: unknown): SkillReviewReceipt {
  if (!isRecord(value)) throw new Error("Invalid project skill review receipt.");
  exactKeys(value, [
    "version", "jobId", "jobDigest", "promptVersion", "systemPromptDigest", "initialPromptDigest",
    "requestDigest", "operationDigest", "target", "outcomeDigest", "receiptDigest", "profile", "attempts",
  ]);
  if (value.version !== 1 || value.promptVersion !== 1 || typeof value.jobId !== "string" || !JOB_ID.test(value.jobId)) {
    throw new Error("Invalid project skill review receipt.");
  }
  if (!Array.isArray(value.attempts) || value.attempts.length < 1 || value.attempts.length > 2) {
    throw new Error("Invalid project skill review receipt attempts.");
  }
  const jobDigest = hex(value.jobDigest, "job digest");
  const systemPromptDigest = hex(value.systemPromptDigest, "system prompt digest");
  const initialPromptDigest = hex(value.initialPromptDigest, "initial prompt digest");
  const requestDigest = hex(value.requestDigest, "request digest");
  const operationDigest = hex(value.operationDigest, "operation digest");
  const target = parseTarget(value.target);
  const outcomeDigest = hex(value.outcomeDigest, "outcome digest");
  const receiptDigest = hex(value.receiptDigest, "receipt digest");
  const profile = parseProfile(value.profile);
  const attempts = value.attempts.map((attempt, index) => parseAttempt(attempt, index + 1));
  if (value.jobId !== `skill_review_${jobDigest.slice(0, 40)}`) throw new Error("Project skill review job binding mismatch.");
  if (attempts[0]!.promptDigest !== initialPromptDigest || attempts[0]!.requestDigest !== requestDigest) {
    throw new Error("Project skill review initial request binding mismatch.");
  }
  for (const attempt of attempts) {
    const expectedRequest = skillReviewRequestDigest({
      promptVersion: 1,
      systemPromptDigest,
      promptDigest: attempt.promptDigest,
    });
    if (attempt.requestDigest !== expectedRequest) throw new Error("Project skill review attempt request binding mismatch.");
    if (attempt.provider !== profile.provider || attempt.model !== profile.model || attempt.api !== profile.api) {
      throw new Error("Project skill review attempt does not match its requested profile.");
    }
  }
  const expectedOutcomeDigest = digest({
    disposition: "proposed",
    jobId: value.jobId,
    jobDigest,
    operationDigest,
    target,
    attempts,
  } as unknown as Json);
  if (outcomeDigest !== expectedOutcomeDigest) throw new Error("Project skill review outcome digest mismatch.");
  const core = {
    version: 1 as const,
    jobId: value.jobId,
    jobDigest,
    promptVersion: 1 as const,
    systemPromptDigest,
    initialPromptDigest,
    requestDigest,
    operationDigest,
    target,
    outcomeDigest,
    profile,
    attempts,
  };
  if (receiptDigest !== digest(core as unknown as Json)) throw new Error("Project skill review receipt digest mismatch.");
  return { ...core, receiptDigest };
}
