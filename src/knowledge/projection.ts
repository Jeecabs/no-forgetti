import {
  applicabilitySpecificity,
  DEFAULT_ACTIVATION_POLICY,
  evaluateActivation,
  resolveApplicableClaims,
  type ActivationPolicy,
  type ActivationReason,
} from "./policy.ts";
import type {
  Claim,
  ClaimId,
  Evidence,
  Importance,
  KnowledgeEvent,
  RuntimeApplicability,
} from "./types.ts";

export interface ProjectionBudget {
  maxChars?: number;
  maxTokens?: number;
}

export interface ProjectionInput {
  claims: readonly Claim[];
  evidence: readonly Evidence[];
  context: RuntimeApplicability;
  budget: ProjectionBudget;
  events?: readonly KnowledgeEvent[];
  now?: string | number | Date;
  policy?: ActivationPolicy;
  estimateTokens?: (text: string) => number;
  renderClaim?: (claim: Claim) => string;
}

export interface RankingFactors {
  importance: number;
  utility: number;
  commonness: number;
  confidenceFloor: number;
  freshness: number;
  specificity: number;
  score: number;
}

export interface ProjectedClaim {
  claim: Claim;
  rendered: string;
  ranking: RankingFactors;
}

export interface WithheldClaim {
  claimId: ClaimId;
  reason: ActivationReason | "character-budget" | "token-budget" | "empty-rendering";
}

export interface KnowledgeProjection {
  text: string;
  selected: readonly ProjectedClaim[];
  withheld: readonly WithheldClaim[];
  usedChars: number;
  estimatedTokens: number;
}

const importanceValue: Record<Importance, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

function unit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function epoch(value: string | number | Date | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function freshnessValue(claim: Claim, at: string | number | Date | undefined): number {
  const asOf = epoch(claim.freshness.asOf);
  const now = epoch(at);
  if (asOf === undefined || now === undefined || now < asOf) return 0;

  const bounds: number[] = [];
  if (claim.freshness.staleAfter !== undefined) {
    const absolute = epoch(claim.freshness.staleAfter);
    if (absolute !== undefined) bounds.push(absolute);
  }
  if (claim.freshness.maxAgeMs !== undefined && Number.isFinite(claim.freshness.maxAgeMs)) {
    bounds.push(asOf + Math.max(0, claim.freshness.maxAgeMs));
  }
  if (bounds.length === 0) return 1;

  const staleAt = Math.min(...bounds);
  if (staleAt <= asOf || now >= staleAt) return 0;
  return unit((staleAt - now) / (staleAt - asOf));
}

/** Ranking is deliberately derived only at projection time; no composite popularity score is persisted. */
export function rankProjectionClaim(
  claim: Claim,
  context: RuntimeApplicability,
  at: string | number | Date | undefined,
): RankingFactors {
  const importance = importanceValue[claim.importance];
  const utility = unit(claim.utility);
  const commonness = unit(claim.commonness);
  const confidenceFloor = Math.min(
    unit(claim.confidence.truth),
    unit(claim.confidence.extraction),
    unit(claim.confidence.scope),
  );
  const freshness = freshnessValue(claim, at);
  const specificity = applicabilitySpecificity(claim, context);

  // Importance has its own band: a common convenience cannot outrank a critical invariant.
  const score = importance
    + utility * 0.35
    + confidenceFloor * 0.25
    + commonness * 0.15
    + freshness * 0.1
    + Math.min(specificity / 400_000, 1) * 0.05;
  return { importance, utility, commonness, confidenceFloor, freshness, specificity, score };
}

function defaultRender(claim: Claim): string {
  return `- ${claim.statement.replace(/\s+/gu, " ").trim()}`;
}

function defaultTokenEstimate(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function limit(value: number | undefined): number {
  if (value === undefined || value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function tokenCount(text: string, estimate: (text: string) => number): number {
  const result = estimate(text);
  return Number.isFinite(result) && result >= 0 ? Math.ceil(result) : Number.POSITIVE_INFINITY;
}

function compareRank(left: ProjectedClaim, right: ProjectedClaim): number {
  if (left.ranking.score !== right.ranking.score) return right.ranking.score - left.ranking.score;
  if (left.ranking.importance !== right.ranking.importance) {
    return right.ranking.importance - left.ranking.importance;
  }
  if (left.ranking.specificity !== right.ranking.specificity) {
    return right.ranking.specificity - left.ranking.specificity;
  }
  return left.claim.id < right.claim.id ? -1 : left.claim.id > right.claim.id ? 1 : 0;
}

export function buildKnowledgeProjection(input: ProjectionInput): KnowledgeProjection {
  const now = input.now ?? input.context.at;
  const policy = input.policy ?? DEFAULT_ACTIVATION_POLICY;
  const render = input.renderClaim ?? defaultRender;
  const estimate = input.estimateTokens ?? defaultTokenEstimate;
  const maxChars = limit(input.budget.maxChars);
  const maxTokens = limit(input.budget.maxTokens);
  const withheld: WithheldClaim[] = [];

  // Applicability and narrow overrides happen before activation. A contested exception cannot leak a broad fallback.
  const applicable = resolveApplicableClaims(input.claims, input.context);
  const ranked: ProjectedClaim[] = [];
  for (const claim of applicable) {
    const decision = evaluateActivation(claim, input.evidence, {
      events: input.events,
      now,
      policy,
    });
    if (!decision.active) {
      withheld.push({ claimId: claim.id, reason: decision.reason });
      continue;
    }

    const rendered = render(claim).trim();
    if (!rendered) {
      withheld.push({ claimId: claim.id, reason: "empty-rendering" });
      continue;
    }
    ranked.push({ claim, rendered, ranking: rankProjectionClaim(claim, input.context, now) });
  }
  ranked.sort(compareRank);

  // Compose only after filtering and ranking. Check complete candidate text against both independent budgets.
  const selected: ProjectedClaim[] = [];
  let text = "";
  for (const candidate of ranked) {
    const composed = text === "" ? candidate.rendered : `${text}\n${candidate.rendered}`;
    if (composed.length > maxChars) {
      withheld.push({ claimId: candidate.claim.id, reason: "character-budget" });
      continue;
    }
    if (tokenCount(composed, estimate) > maxTokens) {
      withheld.push({ claimId: candidate.claim.id, reason: "token-budget" });
      continue;
    }
    text = composed;
    selected.push(candidate);
  }

  return {
    text,
    selected,
    withheld,
    usedChars: text.length,
    estimatedTokens: tokenCount(text, estimate),
  };
}

export const projectClaims = buildKnowledgeProjection;
