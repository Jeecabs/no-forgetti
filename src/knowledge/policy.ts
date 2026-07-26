import type {
  Claim,
  ClaimValidity,
  Evidence,
  EvidenceId,
  EpistemicConfidence,
  Freshness,
  KnowledgeEvent,
  RuntimeApplicability,
} from "./types.ts";

export interface ActivationPolicy {
  minTruthConfidence: number;
  minExtractionConfidence: number;
  minScopeConfidence: number;
  commonnessThreshold: number;
  minIndependentCommonSources: number;
}

export const DEFAULT_ACTIVATION_POLICY: Readonly<ActivationPolicy> = Object.freeze({
  minTruthConfidence: 0.8,
  minExtractionConfidence: 0.8,
  minScopeConfidence: 0.75,
  commonnessThreshold: 0.6,
  minIndependentCommonSources: 2,
});

export interface EvidenceContribution extends EpistemicConfidence {
  commonness: number;
}

export type ActivationReason =
  | "active"
  | "contested"
  | "not-current"
  | "outside-validity-window"
  | "stale"
  | "corrected"
  | "low-truth-confidence"
  | "low-extraction-confidence"
  | "low-scope-confidence"
  | "no-independent-evidence"
  | "insufficient-commonness"
  | "insufficient-common-support";

export interface ActivationDecision {
  active: boolean;
  reason: ActivationReason;
  independentEvidenceCount: number;
  independentCommonEvidenceCount: number;
  verified: boolean;
}

export interface ActivationOptions {
  events?: readonly KnowledgeEvent[];
  now?: string | number | Date;
  policy?: ActivationPolicy;
}

function probability(value: number): number {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

function epoch(value: string | number | Date | undefined): number | undefined {
  if (value === undefined) return undefined;
  const result = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
}

export function isMemoryDerived(evidence: Evidence): boolean {
  return evidence.source.kind === "memory" || (evidence.derivedFromMemory?.length ?? 0) > 0;
}

/** Memory is retrieval, not a fresh observation. It cannot manufacture truth or prevalence. */
export function evidenceContribution(evidence: Evidence): EvidenceContribution {
  return {
    truth: isMemoryDerived(evidence) ? 0 : probability(evidence.confidence.truth),
    extraction: probability(evidence.confidence.extraction),
    scope: probability(evidence.confidence.scope),
    commonness: isMemoryDerived(evidence) ? 0 : probability(evidence.commonness),
  };
}

export function evidenceIndependenceKey(evidence: Evidence): string {
  if (evidence.independenceKey) return `explicit:${evidence.independenceKey}`;
  if (evidence.derivedFromMemory?.length) {
    return `memory:${[...new Set(evidence.derivedFromMemory)].sort().join("|")}`;
  }
  if (evidence.derivedFromEvidence?.length) {
    return `evidence:${[...new Set(evidence.derivedFromEvidence)].sort().join("|")}`;
  }
  if (evidence.source.id) return `source:${evidence.source.kind}:${evidence.source.id}`;
  return `record:${evidence.id}`;
}

export function countIndependentEvidence(evidence: readonly Evidence[]): number {
  return new Set(evidence.map(evidenceIndependenceKey)).size;
}

function confidenceFailure(claim: Claim, policy: ActivationPolicy): ActivationReason | undefined {
  if (probability(claim.confidence.truth) < policy.minTruthConfidence) return "low-truth-confidence";
  if (probability(claim.confidence.extraction) < policy.minExtractionConfidence) return "low-extraction-confidence";
  if (probability(claim.confidence.scope) < policy.minScopeConfidence) return "low-scope-confidence";
  return undefined;
}

function validityFailure(validity: ClaimValidity, now: number | undefined): ActivationReason | undefined {
  if (validity.status === "contested") return "contested";
  if (validity.status !== "current") return "not-current";

  if (validity.validFrom !== undefined || validity.validUntil !== undefined) {
    if (now === undefined) return "outside-validity-window";
    const from = validity.validFrom === undefined ? undefined : epoch(validity.validFrom);
    const until = validity.validUntil === undefined ? undefined : epoch(validity.validUntil);
    if ((validity.validFrom !== undefined && from === undefined)
      || (validity.validUntil !== undefined && until === undefined)
      || (from !== undefined && now < from)
      || (until !== undefined && now >= until)) {
      return "outside-validity-window";
    }
  }
  return undefined;
}

export function isFreshAt(freshness: Freshness, at?: string | number | Date): boolean {
  const asOf = epoch(freshness.asOf);
  if (asOf === undefined) return false;

  const hasBound = freshness.staleAfter !== undefined || freshness.maxAgeMs !== undefined;
  const now = epoch(at);
  if (now === undefined) return !hasBound;
  if (now < asOf) return false;

  let staleAt = Number.POSITIVE_INFINITY;
  if (freshness.staleAfter !== undefined) {
    const absolute = epoch(freshness.staleAfter);
    if (absolute === undefined) return false;
    staleAt = Math.min(staleAt, absolute);
  }
  if (freshness.maxAgeMs !== undefined) {
    if (!Number.isFinite(freshness.maxAgeMs) || freshness.maxAgeMs < 0) return false;
    staleAt = Math.min(staleAt, asOf + freshness.maxAgeMs);
  }
  return now < staleAt;
}

function effectiveEvent(event: KnowledgeEvent, now: number | undefined): boolean {
  const at = epoch(event.at);
  if (at === undefined) return event.type === "corrected";
  return now === undefined || at <= now;
}

function supportingEvidence(
  claim: Claim,
  evidence: readonly Evidence[],
  policy: ActivationPolicy,
): { independent: number; common: number } {
  const requested = new Set(claim.evidenceIds);
  const eligible = evidence.filter((item) => {
    if (!requested.has(item.id)) return false;
    const contribution = evidenceContribution(item);
    return contribution.truth >= policy.minTruthConfidence
      && contribution.extraction >= policy.minExtractionConfidence
      && contribution.scope >= policy.minScopeConfidence;
  });

  const independent = new Set(eligible.map(evidenceIndependenceKey));
  const common = new Set(
    eligible
      .filter((item) => evidenceContribution(item).commonness >= policy.commonnessThreshold)
      .map(evidenceIndependenceKey),
  );
  return { independent: independent.size, common: common.size };
}

export function evaluateActivation(
  claim: Claim,
  evidence: readonly Evidence[],
  options: ActivationOptions = {},
): ActivationDecision {
  const policy = options.policy ?? DEFAULT_ACTIVATION_POLICY;
  const now = epoch(options.now);
  const events = (options.events ?? []).filter((event) => event.claimId === claim.id && effectiveEvent(event, now));
  const empty = { independentEvidenceCount: 0, independentCommonEvidenceCount: 0, verified: false };

  const validity = validityFailure(claim.validity, now);
  if (validity) return { active: false, reason: validity, ...empty };
  if (!isFreshAt(claim.freshness, options.now)) return { active: false, reason: "stale", ...empty };
  if (events.some((event) => event.type === "corrected")) {
    return { active: false, reason: "corrected", ...empty };
  }

  const confidence = confidenceFailure(claim, policy);
  if (confidence) return { active: false, reason: confidence, ...empty };

  const support = supportingEvidence(claim, evidence, policy);
  const verified = events.some((event) => event.type === "verified");
  const counts = {
    independentEvidenceCount: support.independent,
    independentCommonEvidenceCount: support.common,
    verified,
  };
  if (support.independent === 0) return { active: false, reason: "no-independent-evidence", ...counts };

  // Safety invariants may be rare. Criticality can lower prevalence requirements, never confidence requirements.
  if (claim.importance === "critical" || verified) return { active: true, reason: "active", ...counts };
  if (probability(claim.commonness) < policy.commonnessThreshold) {
    return { active: false, reason: "insufficient-commonness", ...counts };
  }
  if (support.common < policy.minIndependentCommonSources) {
    return { active: false, reason: "insufficient-common-support", ...counts };
  }
  return { active: true, reason: "active", ...counts };
}

export function shouldActivateClaim(
  claim: Claim,
  evidence: readonly Evidence[],
  options: ActivationOptions = {},
): boolean {
  return evaluateActivation(claim, evidence, options).active;
}

function normalizePath(value: string): string {
  const slashes = value.trim().replaceAll("\\", "/").replace(/\/+/gu, "/");
  const withoutDot = slashes.replace(/^\.\//u, "");
  if (withoutDot === "/") return withoutDot;
  return withoutDot.replace(/\/$/u, "");
}

function inDirectory(filePath: string, directory: string): boolean {
  const file = normalizePath(filePath);
  const dir = normalizePath(directory);
  if (dir === "" || dir === ".") return true;
  return file === dir || file.startsWith(`${dir}/`);
}

function listed<T>(values: readonly T[] | undefined, actual: T | undefined): boolean {
  return values === undefined || (actual !== undefined && values.includes(actual));
}

export function matchesApplicability(claim: Claim, context: RuntimeApplicability): boolean {
  const project = context.projectId;
  const file = context.filePath;
  const locusMatches = claim.locus.kind === "universal"
    || (claim.locus.kind === "project" && project === claim.locus.projectId)
    || (claim.locus.kind === "directory"
      && project === claim.locus.projectId
      && file !== undefined
      && inDirectory(file, claim.locus.path))
    || (claim.locus.kind === "file"
      && project === claim.locus.projectId
      && file !== undefined
      && normalizePath(file) === normalizePath(claim.locus.path));
  if (!locusMatches) return false;

  const selector = claim.applicability;
  if (!listed(selector.projects, project)
    || !listed(selector.tasks, context.task)
    || !listed(selector.languages, context.language)
    || !listed(selector.commands, context.command)) return false;

  if (selector.exactFiles !== undefined
    && (file === undefined || !selector.exactFiles.some((candidate) => normalizePath(candidate) === normalizePath(file)))) {
    return false;
  }
  if (selector.directories !== undefined
    && (file === undefined || !selector.directories.some((directory) => inDirectory(file, directory)))) {
    return false;
  }
  if (file !== undefined && selector.excludeExactFiles?.some((candidate) => normalizePath(candidate) === normalizePath(file))) {
    return false;
  }
  if (file !== undefined && selector.excludeDirectories?.some((directory) => inDirectory(file, directory))) {
    return false;
  }

  const tags = new Set(context.tags ?? []);
  if (selector.tagsAll?.some((tag) => !tags.has(tag))) return false;
  if (selector.tagsAny !== undefined && !selector.tagsAny.some((tag) => tags.has(tag))) return false;
  return true;
}

function pathDepth(value: string): number {
  return normalizePath(value).split("/").filter(Boolean).length;
}

/** Higher values mean narrower applicability. Major bands prevent extra tags outranking an exact file. */
export function applicabilitySpecificity(claim: Claim, context: RuntimeApplicability): number {
  let score = claim.locus.kind === "file"
    ? 400_000
    : claim.locus.kind === "directory"
      ? 300_000 + pathDepth(claim.locus.path)
      : claim.locus.kind === "project"
        ? 200_000
        : 100_000;

  if (claim.applicability.exactFiles !== undefined) score = Math.max(score, 400_000);
  if (claim.applicability.directories !== undefined && context.filePath !== undefined) {
    const depths = claim.applicability.directories
      .filter((directory) => inDirectory(context.filePath!, directory))
      .map(pathDepth);
    if (depths.length) score = Math.max(score, 300_000 + Math.max(...depths));
  }
  if (claim.applicability.projects !== undefined) score = Math.max(score, 200_000);

  const selector = claim.applicability;
  score += Number(selector.tasks !== undefined)
    + Number(selector.languages !== undefined)
    + Number(selector.commands !== undefined)
    + Number(selector.tagsAll !== undefined)
    + Number(selector.tagsAny !== undefined);
  return score;
}

/** Resolve alternatives by key after matching. A narrow exception suppresses broader fallback. */
export function resolveApplicableClaims(
  claims: readonly Claim[],
  context: RuntimeApplicability,
): Claim[] {
  const byKey = new Map<string, Array<{ claim: Claim; specificity: number }>>();
  for (const claim of claims) {
    if (!matchesApplicability(claim, context)) continue;
    const candidates = byKey.get(claim.key) ?? [];
    candidates.push({ claim, specificity: applicabilitySpecificity(claim, context) });
    byKey.set(claim.key, candidates);
  }

  const resolved: Claim[] = [];
  for (const candidates of byKey.values()) {
    const narrowest = Math.max(...candidates.map((candidate) => candidate.specificity));
    resolved.push(...candidates
      .filter((candidate) => candidate.specificity === narrowest)
      .map((candidate) => candidate.claim));
  }
  return resolved.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
