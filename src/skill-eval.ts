import type { ReviewerProfile } from "./service/config.ts";
import { createHash } from "node:crypto";

import type { ModelDispatchContext, ModelRunner, ReviewModelProvenance } from "./service/model-runner.ts";
import type { SkillAuthorshipCatalogEntry, SkillAuthorshipDocument } from "./skill-authorship-packet.ts";
import { SkillReviewEngine, type SkillReviewExecutionOutcome } from "./skill-review-engine.ts";
import { skillReviewRequestDigest, type SkillReviewJob } from "./skill-review-job.ts";
import type { SkillOperation } from "./skill-types.ts";

export type SkillEvalExpectedAction = SkillOperation["action"] | "no-change";
export type SkillEvalRisk = "standard" | "critical";

export interface SkillEvalTextProxy {
  /** Every group must match at least one case-insensitive alternative. */
  required?: readonly (readonly string[])[];
  /** Every term must remain absent. */
  forbidden?: readonly string[];
  completionCriterion?: boolean;
}

export interface SkillEvalExpectation {
  action: SkillEvalExpectedAction;
  targetName?: string;
  semantic?: SkillEvalTextProxy;
  invocation?: SkillEvalTextProxy;
  downstream?: SkillEvalTextProxy;
}

export interface SkillEvalCase {
  id: string;
  risk: SkillEvalRisk;
  job: Readonly<SkillReviewJob>;
  expectation: SkillEvalExpectation;
}

export interface SkillEvalReviewerProfile {
  provider: string;
  model: string;
  reasoningEffort: ReviewerProfile["reasoningEffort"];
  maxOutputTokens: number;
}

export interface SkillEvalCandidate {
  id: string;
  profile: SkillEvalReviewerProfile;
  runner: ModelRunner;
}

export interface SkillEvalProfileBinding extends SkillEvalReviewerProfile {
  digest: string;
}

export type SkillEvalReplayCase = {
  caseId: string;
  jobId: string;
  jobDigest: string;
  dispatchRequestDigests: string[];
} & (
  | { outcome: SkillReviewExecutionOutcome }
  | { failure: "execution-error" }
);

export interface SkillEvalReplay {
  candidateId: string;
  profile: SkillEvalProfileBinding;
  dispatches: ModelDispatchContext[];
  cases: SkillEvalReplayCase[];
}

export interface SkillEvalMetric {
  passed: number;
  checks: number;
  score: number;
}

export interface SkillEvalCaseScore {
  caseId: string;
  jobId: string;
  jobDigest: string;
  risk: SkillEvalRisk;
  disposition: SkillReviewExecutionOutcome["disposition"] | "execution-error";
  action: SkillEvalMetric;
  semantic: SkillEvalMetric;
  invocation: SkillEvalMetric;
  downstream: SkillEvalMetric;
  overall: number;
  passed: boolean;
}

export interface SkillEvalProvenanceAggregate {
  attempts: number;
  invalidOutputAttempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  runnerFailures: number;
  invalidOutcomes: number;
  providers: string[];
  models: string[];
  apis: string[];
  responseModels: string[];
}

export interface SkillEvalCandidateReport {
  candidateId: string;
  profile: SkillEvalProfileBinding;
  dispatch: {
    calls: number;
    complete: boolean;
    requestDigests: string[];
    profileRequestDigests: string[];
    attemptBindingDigests: string[];
    providers: string[];
    models: string[];
    apis: string[];
    heldTokens: number;
    heldCostUsd: number;
  };
  cases: SkillEvalCaseScore[];
  summary: {
    totalCases: number;
    passedCases: number;
    criticalFailures: string[];
    meanScore: number;
    noChangeCases: number;
    noChangePassed: number;
    noChangePrecisionLowerBound: number;
    expectedProposalCases: number;
    predictedProposals: number;
    correctProposals: number;
    proposalPrecisionLowerBound: number;
  };
  provenance: SkillEvalProvenanceAggregate;
}

export interface SkillEvalComparison {
  baselineId: string;
  candidateId: string;
  recommendation: "admit" | "hold";
  regressions: string[];
  improvements: string[];
  criticalFailures: string[];
  gateFailures: string[];
  pairedNonInferiorityLowerBound: number;
  noChangePrecisionLowerBound: number;
  proposalPrecisionLowerBound: number;
}

function safeCandidateId(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)) throw new Error(`Invalid skill eval candidate id '${value}'.`);
  return value;
}

function profileBinding(profile: SkillEvalReviewerProfile): SkillEvalProfileBinding {
  for (const value of [profile.provider, profile.model, profile.reasoningEffort]) {
    if (!value || value.length > 256 || /[\u0000-\u001F\u007F]/u.test(value)) throw new Error("Invalid skill eval reviewer profile.");
  }
  if (!Number.isSafeInteger(profile.maxOutputTokens) || profile.maxOutputTokens < 1) {
    throw new Error("Invalid skill eval reviewer output-token limit.");
  }
  const digest = createHash("sha256").update(JSON.stringify([
    profile.provider, profile.model, profile.reasoningEffort, profile.maxOutputTokens,
  ]), "utf8").digest("hex");
  return {
    provider: profile.provider,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    maxOutputTokens: profile.maxOutputTokens,
    digest,
  };
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

function scoreText(value: string | undefined, proxy: SkillEvalTextProxy | undefined): SkillEvalMetric {
  const haystack = normalized(value ?? "");
  let checks = 0;
  let passed = 0;
  for (const alternatives of proxy?.required ?? []) {
    checks += 1;
    if (alternatives.length > 0 && alternatives.some((term) => haystack.includes(normalized(term)))) passed += 1;
  }
  for (const term of proxy?.forbidden ?? []) {
    checks += 1;
    if (!haystack.includes(normalized(term))) passed += 1;
  }
  if (proxy?.completionCriterion !== undefined) {
    checks += 1;
    const hasCriterion = /\b(?:done when|completion criterion)\s*:/iu.test(value ?? "");
    if (hasCriterion === proxy.completionCriterion) passed += 1;
  }
  return { passed, checks, score: checks === 0 ? 1 : passed / checks };
}

function exactActionMetric(caseDefinition: SkillEvalCase, outcome: SkillReviewExecutionOutcome | undefined): SkillEvalMetric {
  const expected = caseDefinition.expectation;
  let matches = false;
  if (expected.action === "no-change") {
    matches = outcome?.disposition === "no-change" && outcome.plan.operations.length === 0;
  } else {
    const operation = outcome?.plan.operations.at(0);
    matches = outcome?.disposition === "proposed"
      && operation?.action === expected.action
      && (expected.targetName === undefined || operation.name === expected.targetName);
  }
  return { passed: matches ? 1 : 0, checks: 1, score: matches ? 1 : 0 };
}

interface ProjectedSkill {
  description?: string;
  content?: string;
}

function visibleSkill(
  catalog: readonly SkillAuthorshipCatalogEntry[],
  documents: readonly SkillAuthorshipDocument[],
  name: string,
): ProjectedSkill {
  return {
    description: catalog.find((skill) => skill.name === name)?.description,
    content: documents.find((skill) => skill.name === name)?.content,
  };
}

function replaceOnce(value: string | undefined, oldText: string, newText: string): { value?: string; changed: boolean } {
  if (value === undefined || !oldText || value.split(oldText).length - 1 !== 1) return { value, changed: false };
  return { value: value.replace(oldText, newText), changed: true };
}

function projectedSkill(caseDefinition: SkillEvalCase, outcome: SkillReviewExecutionOutcome | undefined): ProjectedSkill {
  const operation = outcome?.plan.operations.at(0);
  if (!operation) return {};
  if (operation.action === "create") {
    return { description: operation.description, content: operation.content };
  }
  if (operation.action === "archive") return {};
  const current = visibleSkill(caseDefinition.job.packet.corpus.catalog, caseDefinition.job.packet.corpus.documents, operation.name);
  const description = replaceOnce(current.description, operation.oldText ?? "", operation.newText ?? "");
  if (description.changed) return { ...current, description: description.value };
  const content = replaceOnce(current.content, operation.oldText ?? "", operation.newText ?? "");
  return { ...current, content: content.value };
}

function scoreCase(caseDefinition: SkillEvalCase, replay: SkillEvalReplayCase): SkillEvalCaseScore {
  const outcome = "outcome" in replay ? replay.outcome : undefined;
  const operation = outcome?.plan.operations.at(0);
  const semanticText = operation
    ? [operation.reason ?? "", ...(operation.evidence ?? [])].join("\n")
    : undefined;
  const projected = projectedSkill(caseDefinition, outcome);
  const action = exactActionMetric(caseDefinition, outcome);
  const semantic = scoreText(semanticText, caseDefinition.expectation.semantic);
  const invocation = scoreText(projected.description, caseDefinition.expectation.invocation);
  const downstream = scoreText(projected.content, caseDefinition.expectation.downstream);
  const overall = (action.score + semantic.score + invocation.score + downstream.score) / 4;
  return {
    caseId: caseDefinition.id,
    jobId: replay.jobId,
    jobDigest: replay.jobDigest,
    risk: caseDefinition.risk,
    disposition: outcome?.disposition ?? "execution-error",
    action,
    semantic,
    invocation,
    downstream,
    overall,
    passed: action.score === 1 && semantic.score === 1 && invocation.score === 1 && downstream.score === 1,
  };
}

function aggregateProvenance(replay: SkillEvalReplay): SkillEvalProvenanceAggregate {
  const aggregate: SkillEvalProvenanceAggregate = {
    attempts: 0,
    invalidOutputAttempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    durationMs: 0,
    runnerFailures: 0,
    invalidOutcomes: 0,
    providers: [],
    models: [],
    apis: [],
    responseModels: [],
  };
  const providers = new Set<string>();
  const models = new Set<string>();
  const apis = new Set<string>();
  const responseModels = new Set<string>();
  const addProvenance = (provenance: ReviewModelProvenance): void => {
    aggregate.inputTokens += provenance.usage.input;
    aggregate.outputTokens += provenance.usage.output;
    aggregate.cacheReadTokens += provenance.usage.cacheRead;
    aggregate.cacheWriteTokens += provenance.usage.cacheWrite;
    aggregate.totalTokens += provenance.usage.totalTokens;
    aggregate.costUsd += provenance.usage.cost.total;
    aggregate.durationMs += provenance.durationMs;
    providers.add(provenance.provider);
    models.add(provenance.model);
    apis.add(provenance.api);
    if (provenance.responseModel) responseModels.add(provenance.responseModel);
  };
  for (const item of replay.cases) {
    if (!("outcome" in item)) continue;
    if (item.outcome.disposition === "runner-failure" || item.outcome.disposition === "aborted") aggregate.runnerFailures += 1;
    if (item.outcome.disposition === "invalid-output") aggregate.invalidOutcomes += 1;
    for (const attempt of item.outcome.attempts) {
      aggregate.attempts += 1;
      if (attempt.validationErrorCode) aggregate.invalidOutputAttempts += 1;
      addProvenance(attempt.provenance);
    }
    if (item.outcome.failure?.provenance) addProvenance(item.outcome.failure.provenance);
  }
  aggregate.providers = [...providers].sort();
  aggregate.models = [...models].sort();
  aggregate.apis = [...apis].sort();
  aggregate.responseModels = [...responseModels].sort();
  return aggregate;
}

function assertReplayJobs(cases: readonly SkillEvalCase[], replay: SkillEvalReplay): void {
  const checkedProfile = profileBinding(replay.profile);
  if (checkedProfile.digest !== replay.profile.digest) throw new Error("Skill eval reviewer profile digest mismatch.");
  if (replay.dispatches.some((dispatch) => (
    dispatch.provider !== replay.profile.provider || dispatch.model !== replay.profile.model
  ))) throw new Error("Skill eval dispatch does not match its requested reviewer profile.");
  if (replay.cases.length !== cases.length) throw new Error("Skill eval replay must contain the same frozen case jobs.");
  const seen = new Set<string>();
  for (const [index, caseDefinition] of cases.entries()) {
    const item = replay.cases[index];
    if (!item || item.caseId !== caseDefinition.id || item.jobId !== caseDefinition.job.id) {
      throw new Error("Skill eval replay must contain the same frozen case jobs in order.");
    }
    if (item.jobDigest !== caseDefinition.job.digest) throw new Error(`Skill eval replay job digest mismatch for '${caseDefinition.id}'.`);
    if (seen.has(item.caseId)) throw new Error("Skill eval replay must contain the same frozen case jobs exactly once.");
    seen.add(item.caseId);
    if ("outcome" in item
      && (item.outcome.jobId !== item.jobId || item.outcome.jobDigest !== item.jobDigest)) {
      throw new Error(`Skill eval outcome binding mismatch for '${caseDefinition.id}'.`);
    }
  }
}

export async function runSkillEvalCandidates(
  cases: readonly SkillEvalCase[],
  candidates: readonly SkillEvalCandidate[],
): Promise<SkillEvalReplay[]> {
  const ids = candidates.map(({ id }) => safeCandidateId(id));
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate skill eval candidate id.");
  const replays: SkillEvalReplay[] = [];
  for (const candidate of candidates) {
    const engine = new SkillReviewEngine(candidate.runner);
    const profile = profileBinding(candidate.profile);
    const dispatches: ModelDispatchContext[] = [];
    const replayCases: SkillEvalReplayCase[] = [];
    for (const caseDefinition of cases) {
      const dispatchStart = dispatches.length;
      try {
        const outcome = await engine.review(caseDefinition.job, undefined, {
          beforeDispatch: (context) => {
            dispatches.push({ ...context, hold: { ...context.hold } });
          },
        });
        replayCases.push({
          caseId: caseDefinition.id,
          jobId: caseDefinition.job.id,
          jobDigest: caseDefinition.job.digest,
          dispatchRequestDigests: dispatches.slice(dispatchStart).map(({ requestDigest }) => requestDigest),
          outcome,
        });
      } catch {
        // Provider/auth failures are scored conservatively without retaining raw error text.
        replayCases.push({
          caseId: caseDefinition.id,
          jobId: caseDefinition.job.id,
          jobDigest: caseDefinition.job.digest,
          dispatchRequestDigests: dispatches.slice(dispatchStart).map(({ requestDigest }) => requestDigest),
          failure: "execution-error",
        });
      }
    }
    replays.push({ candidateId: candidate.id, profile, dispatches, cases: replayCases });
  }
  return replays;
}

function wilsonLowerBound(passed: number, total: number): number {
  if (total < 1) return 0;
  const z = 1.96;
  const proportion = passed / total;
  const denominator = 1 + (z * z) / total;
  const center = proportion + (z * z) / (2 * total);
  const spread = z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (4 * total)) / total);
  return Math.max(0, (center - spread) / denominator);
}

export function scoreSkillEvalReplay(
  cases: readonly SkillEvalCase[],
  replay: SkillEvalReplay,
): SkillEvalCandidateReport {
  safeCandidateId(replay.candidateId);
  assertReplayJobs(cases, replay);
  const scores = cases.map((caseDefinition, index) => scoreCase(caseDefinition, replay.cases[index]!));
  const criticalFailures = scores.filter((score) => score.risk === "critical" && !score.passed).map(({ caseId }) => caseId);
  const noChangeScores = scores.filter((_score, index) => cases[index]?.expectation.action === "no-change");
  const noChangePassed = noChangeScores.filter(({ action }) => action.score === 1).length;
  const expectedProposalCases = cases.filter(({ expectation }) => expectation.action !== "no-change").length;
  const predictedProposalScores = scores.filter((_score, index) => (
    "outcome" in replay.cases[index]! && replay.cases[index]!.outcome.disposition === "proposed"
  ));
  const correctProposals = predictedProposalScores.filter(({ action }) => action.score === 1).length;
  const completedAttempts = replay.cases.reduce((sum, item) => (
    sum + ("outcome" in item ? item.outcome.attempts.length : 0)
  ), 0);
  const associatedDispatches = replay.cases.flatMap(({ dispatchRequestDigests }) => dispatchRequestDigests);
  const orderedDispatches = replay.dispatches.map(({ requestDigest }) => requestDigest);
  let dispatchCursor = 0;
  let dispatchAttested = true;
  const attemptBindingDigests: string[] = [];
  for (const [caseIndex, item] of replay.cases.entries()) {
    if (!("outcome" in item) || item.dispatchRequestDigests.length !== item.outcome.attempts.length) {
      dispatchAttested = false;
      continue;
    }
    const job = cases[caseIndex]!.job;
    for (const [attemptIndex, attempt] of item.outcome.attempts.entries()) {
      const dispatch = replay.dispatches[dispatchCursor];
      dispatchCursor += 1;
      const expectedRequest = skillReviewRequestDigest({
        promptVersion: job.contract.promptVersion,
        systemPromptDigest: job.contract.systemPromptDigest,
        promptDigest: attempt.promptDigest,
      });
      if (!dispatch
        || item.dispatchRequestDigests[attemptIndex] !== dispatch.requestDigest
        || attempt.requestDigest !== expectedRequest
        || (attemptIndex === 0 && attempt.promptDigest !== job.contract.initialPromptDigest)
        || dispatch.provider !== replay.profile.provider
        || dispatch.model !== replay.profile.model
        || attempt.provenance.provider !== dispatch.provider
        || attempt.provenance.model !== dispatch.model
        || attempt.provenance.api !== dispatch.api) {
        dispatchAttested = false;
        continue;
      }
      attemptBindingDigests.push(createHash("sha256").update(JSON.stringify([
        item.jobId,
        attempt.ordinal,
        replay.profile.digest,
        dispatch.requestDigest,
        attempt.requestDigest,
        attempt.outputDigest,
        dispatch.provider,
        dispatch.model,
        dispatch.api,
      ]), "utf8").digest("hex"));
    }
  }
  const hasExecutionFailure = replay.cases.some((item) => (
    !("outcome" in item) || item.outcome.disposition === "runner-failure" || item.outcome.disposition === "aborted"
  ));
  return {
    candidateId: replay.candidateId,
    profile: replay.profile,
    dispatch: {
      calls: replay.dispatches.length,
      complete: !hasExecutionFailure
        && dispatchAttested
        && dispatchCursor === replay.dispatches.length
        && replay.dispatches.length === completedAttempts
        && JSON.stringify(associatedDispatches) === JSON.stringify(orderedDispatches),
      requestDigests: replay.dispatches.map(({ requestDigest }) => requestDigest),
      profileRequestDigests: replay.dispatches.map(({ requestDigest }) => createHash("sha256")
        .update(`${replay.profile.digest}\n${requestDigest}`, "utf8")
        .digest("hex")),
      attemptBindingDigests,
      providers: [...new Set(replay.dispatches.map(({ provider }) => provider))].sort(),
      models: [...new Set(replay.dispatches.map(({ model }) => model))].sort(),
      apis: [...new Set(replay.dispatches.map(({ api }) => api))].sort(),
      heldTokens: replay.dispatches.reduce((sum, { hold }) => sum + hold.tokens, 0),
      heldCostUsd: replay.dispatches.reduce((sum, { hold }) => sum + hold.costUsd, 0),
    },
    cases: scores,
    summary: {
      totalCases: scores.length,
      passedCases: scores.filter(({ passed }) => passed).length,
      criticalFailures,
      meanScore: scores.length === 0 ? 0 : scores.reduce((sum, score) => sum + score.overall, 0) / scores.length,
      noChangeCases: noChangeScores.length,
      noChangePassed,
      noChangePrecisionLowerBound: wilsonLowerBound(noChangePassed, noChangeScores.length),
      expectedProposalCases,
      predictedProposals: predictedProposalScores.length,
      correctProposals,
      proposalPrecisionLowerBound: wilsonLowerBound(correctProposals, predictedProposalScores.length),
    },
    provenance: aggregateProvenance(replay),
  };
}

const METRICS = ["action", "semantic", "invocation", "downstream"] as const;
const MIN_SKILL_EVAL_PROMOTION_CASES = 20;

export function compareSkillEvalCandidates(
  baseline: SkillEvalCandidateReport,
  candidate: SkillEvalCandidateReport,
): SkillEvalComparison {
  if (baseline.cases.length !== candidate.cases.length) throw new Error("Skill eval reports use different case sets.");
  const regressions: string[] = [];
  const improvements: string[] = [];
  const pairedDeltas: number[] = [];
  for (const [index, baselineCase] of baseline.cases.entries()) {
    const candidateCase = candidate.cases[index];
    if (!candidateCase
      || baselineCase.caseId !== candidateCase.caseId
      || baselineCase.jobId !== candidateCase.jobId
      || baselineCase.jobDigest !== candidateCase.jobDigest) {
      throw new Error("Skill eval reports use different frozen jobs.");
    }
    pairedDeltas.push(candidateCase.overall - baselineCase.overall);
    for (const metric of METRICS) {
      const delta = candidateCase[metric].score - baselineCase[metric].score;
      if (delta < 0) regressions.push(`${baselineCase.caseId}:${metric}`);
      if (delta > 0) improvements.push(`${baselineCase.caseId}:${metric}`);
    }
  }
  if (candidate.provenance.invalidOutputAttempts > baseline.provenance.invalidOutputAttempts) {
    regressions.push("provenance:invalid-output-attempts");
  } else if (candidate.provenance.invalidOutputAttempts < baseline.provenance.invalidOutputAttempts) {
    improvements.push("provenance:invalid-output-attempts");
  }
  const pairedMean = pairedDeltas.reduce((sum, value) => sum + value, 0) / Math.max(1, pairedDeltas.length);
  const pairedVariance = pairedDeltas.length < 2 ? 0 : pairedDeltas.reduce(
    (sum, value) => sum + ((value - pairedMean) ** 2),
    0,
  ) / (pairedDeltas.length - 1);
  const pairedNonInferiorityLowerBound = pairedMean - 1.645 * Math.sqrt(pairedVariance / Math.max(1, pairedDeltas.length));
  const noChangePrecisionLowerBound = candidate.summary.noChangePrecisionLowerBound;
  const proposalPrecisionLowerBound = candidate.summary.proposalPrecisionLowerBound;
  const criticalFailures = [...candidate.summary.criticalFailures];
  const everyCasePassed = candidate.summary.passedCases === candidate.summary.totalCases;
  const gateFailures: string[] = [];
  if (candidate.summary.totalCases < MIN_SKILL_EVAL_PROMOTION_CASES) gateFailures.push("insufficient-labeled-corpus");
  if (candidate.summary.noChangeCases < 16 || noChangePrecisionLowerBound < 0.8) {
    gateFailures.push("unsafe-negative-specificity-bound");
  }
  if (candidate.summary.expectedProposalCases < 15 || proposalPrecisionLowerBound < 0.75) {
    gateFailures.push("proposal-precision-bound");
  }
  if (pairedNonInferiorityLowerBound < -0.05) gateFailures.push("paired-noninferiority-bound");
  if (!everyCasePassed) gateFailures.push("candidate-case-failures");
  if (candidate.provenance.runnerFailures > 0) gateFailures.push("runner-failures");
  if (!candidate.dispatch.complete) gateFailures.push("missing-dispatch-accounting");
  if (candidate.provenance.invalidOutcomes > 0 || candidate.provenance.invalidOutputAttempts > 0) {
    gateFailures.push("invalid-model-output");
  }
  const costRegressed = baseline.provenance.costUsd === 0
    ? candidate.provenance.costUsd > 0
    : candidate.provenance.costUsd > baseline.provenance.costUsd * 1.25;
  const tokensRegressed = baseline.provenance.totalTokens === 0
    ? candidate.provenance.totalTokens > 0
    : candidate.provenance.totalTokens > baseline.provenance.totalTokens * 1.25;
  if (costRegressed) gateFailures.push("cost-regression-over-25-percent");
  if (tokensRegressed) gateFailures.push("token-regression-over-25-percent");
  const recommendation = regressions.length === 0
    && criticalFailures.length === 0
    && gateFailures.length === 0
    && improvements.length > 0
    ? "admit"
    : "hold";
  return {
    baselineId: baseline.candidateId,
    candidateId: candidate.candidateId,
    recommendation,
    regressions,
    improvements,
    criticalFailures,
    gateFailures,
    pairedNonInferiorityLowerBound,
    noChangePrecisionLowerBound,
    proposalPrecisionLowerBound,
  };
}

export interface SkillEvalCliProfile {
  id: string;
  provider: string;
  model: string;
  reasoningEffort: ReviewerProfile["reasoningEffort"];
}

export interface SkillEvalCliOptions {
  live: true;
  profiles: SkillEvalCliProfile[];
  maxCalls: number;
  maxTokens: number;
  maxCostUsd: number;
  maxOutputTokens: number;
}

function positiveCliNumber(value: string | undefined, label: string, integer: boolean): number {
  if (value === undefined) throw new Error(`Skill eval requires ${label} budget.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isSafeInteger(parsed))) {
    throw new Error(`Invalid skill eval ${label} budget.`);
  }
  return parsed;
}

export function parseSkillEvalCliArgs(args: readonly string[]): SkillEvalCliOptions {
  if (!args.includes("--live")) throw new Error("Live skill eval requires explicit --live consent.");
  const profiles: Array<Partial<SkillEvalCliProfile>> = [];
  let current: Partial<SkillEvalCliProfile> | undefined;
  let maxCalls: string | undefined;
  let maxTokens: string | undefined;
  let maxCostUsd: string | undefined;
  let maxOutputTokens: string | undefined;
  const valueAfter = (index: number, flag: string): string => {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Skill eval ${flag} requires a value.`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--live") continue;
    if (flag === "--candidate") {
      current = { id: valueAfter(index, flag) };
      profiles.push(current);
      index += 1;
      continue;
    }
    if (flag === "--provider" || flag === "--model" || flag === "--reasoning") {
      if (!current) throw new Error(`${flag} must follow an explicit --candidate.`);
      const value = valueAfter(index, flag);
      if (flag === "--provider") current.provider = value;
      if (flag === "--model") current.model = value;
      if (flag === "--reasoning") current.reasoningEffort = value as ReviewerProfile["reasoningEffort"];
      index += 1;
      continue;
    }
    if (["--max-calls", "--max-tokens", "--max-cost-usd", "--max-output-tokens"].includes(flag)) {
      const value = valueAfter(index, flag);
      if (flag === "--max-calls") maxCalls = value;
      if (flag === "--max-tokens") maxTokens = value;
      if (flag === "--max-cost-usd") maxCostUsd = value;
      if (flag === "--max-output-tokens") maxOutputTokens = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown skill eval argument '${flag}'.`);
  }
  if (profiles.length < 2) throw new Error("Live skill eval requires at least two explicit candidate profiles.");
  const reasoning = new Set<ReviewerProfile["reasoningEffort"]>(["off", "minimal", "low", "medium", "high", "xhigh"]);
  const checked = profiles.map((profile): SkillEvalCliProfile => {
    if (!profile.id || !profile.provider || !profile.model || !profile.reasoningEffort) {
      throw new Error("Every skill eval candidate requires id, provider, model, and reasoning profile args.");
    }
    if (!reasoning.has(profile.reasoningEffort)) throw new Error(`Invalid skill eval reasoning '${profile.reasoningEffort}'.`);
    return {
      id: safeCandidateId(profile.id),
      provider: profile.provider,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
    };
  });
  if (new Set(checked.map(({ id }) => id)).size !== checked.length) throw new Error("Duplicate skill eval candidate id.");
  return {
    live: true,
    profiles: checked,
    maxCalls: positiveCliNumber(maxCalls, "--max-calls", true),
    maxTokens: positiveCliNumber(maxTokens, "--max-tokens", true),
    maxCostUsd: positiveCliNumber(maxCostUsd, "--max-cost-usd", false),
    maxOutputTokens: positiveCliNumber(maxOutputTokens, "--max-output-tokens", true),
  };
}

export function reviewerProfileFromSkillEval(
  profile: SkillEvalCliProfile,
  options: Pick<SkillEvalCliOptions, "maxCalls" | "maxTokens" | "maxCostUsd">,
): ReviewerProfile {
  return {
    provider: profile.provider,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    maxCallsPerDay: options.maxCalls,
    maxTokensPerDay: options.maxTokens,
    maxCostPerDayUsd: options.maxCostUsd,
  };
}

/** Aggregate-only JSON projection: no raw model output, evidence, proposal body, or credentials. */
export function publicSkillEvalReport(
  reports: readonly SkillEvalCandidateReport[],
  comparisons: readonly SkillEvalComparison[],
): object {
  return {
    version: 1,
    candidates: reports.map((report) => ({
      candidateId: report.candidateId,
      profile: report.profile,
      dispatch: report.dispatch,
      summary: report.summary,
      provenance: report.provenance,
      cases: report.cases.map(({ caseId, jobId, jobDigest, risk, disposition, action, semantic, invocation, downstream, overall, passed }) => ({
        caseId,
        jobId,
        jobDigest,
        risk,
        disposition,
        action,
        semantic,
        invocation,
        downstream,
        overall,
        passed,
      })),
    })),
    comparisons,
  };
}
