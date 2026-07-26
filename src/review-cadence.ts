import { randomUUID } from "node:crypto";

const REVIEW_LEASE_MS = 5 * 60_000;
const REVIEW_RETRY_BASE_MS = 5 * 60_000;
const REVIEW_RETRY_MAX_MS = 60 * 60_000;

export interface ReviewClaimSnapshot {
  generation: number;
  token: string;
  capturedTurns: number;
  capturedSignalScore: number;
}

export interface ReviewCadenceState<Claim extends ReviewClaimSnapshot> {
  turnsSinceReview: number;
  signalScore: number;
  consecutiveFailures: number;
  generation?: number;
  activeClaim?: Claim;
  lastReviewedAt?: string;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  inFlightUntil?: string;
}

export type ReviewCadenceOutcome = "success" | "failure" | "cancelled";

export function beginReviewClaim<Claim extends ReviewClaimSnapshot>(request: {
  state: ReviewCadenceState<Claim>;
  now: Date;
  generationExhaustedMessage: string;
  createClaim: (snapshot: ReviewClaimSnapshot) => Claim;
}): Claim {
  const { state, now } = request;
  const generation = (state.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation)) throw new Error(request.generationExhaustedMessage);
  const claim = request.createClaim({
    generation,
    token: randomUUID(),
    capturedTurns: state.turnsSinceReview,
    capturedSignalScore: state.signalScore,
  });
  state.generation = generation;
  state.activeClaim = claim;
  state.lastAttemptAt = now.toISOString();
  state.inFlightUntil = new Date(now.getTime() + REVIEW_LEASE_MS).toISOString();
  return claim;
}

function claimIdentity(claim: ReviewClaimSnapshot): string {
  return [claim.generation, claim.token, claim.capturedTurns, claim.capturedSignalScore].join(":");
}

function settleSuccess(state: ReviewCadenceState<ReviewClaimSnapshot>, claim: ReviewClaimSnapshot, now: Date): void {
  state.turnsSinceReview = Math.max(0, state.turnsSinceReview - claim.capturedTurns);
  state.signalScore = Math.max(0, state.signalScore - claim.capturedSignalScore);
  state.consecutiveFailures = 0;
  delete state.nextAttemptAt;
  state.lastReviewedAt = now.toISOString();
}

function settleFailure(state: ReviewCadenceState<ReviewClaimSnapshot>, _claim: ReviewClaimSnapshot, now: Date): void {
  state.consecutiveFailures += 1;
  const delay = Math.min(REVIEW_RETRY_MAX_MS, REVIEW_RETRY_BASE_MS * (2 ** (state.consecutiveFailures - 1)));
  state.nextAttemptAt = new Date(now.getTime() + delay).toISOString();
}

function settleCancellation(_state: ReviewCadenceState<ReviewClaimSnapshot>, _claim: ReviewClaimSnapshot, _now: Date): void {}

const SETTLE_OUTCOME: Record<
  ReviewCadenceOutcome,
  (state: ReviewCadenceState<ReviewClaimSnapshot>, claim: ReviewClaimSnapshot, now: Date) => void
> = {
  success: settleSuccess,
  failure: settleFailure,
  cancelled: settleCancellation,
};

function matchingActiveClaim<Claim extends ReviewClaimSnapshot>(
  state: ReviewCadenceState<Claim>,
  expected: Claim,
): Claim | undefined {
  const active = state.activeClaim;
  if (!active) return undefined;
  return claimIdentity(active) === claimIdentity(expected) ? active : undefined;
}

export function settleReviewClaim<Claim extends ReviewClaimSnapshot>(request: {
  state: ReviewCadenceState<Claim>;
  expected: Claim;
  outcome: ReviewCadenceOutcome;
  now: Date;
}): boolean {
  const { state, expected, outcome, now } = request;
  const active = matchingActiveClaim(state, expected);
  if (!active) return false;
  delete state.activeClaim;
  delete state.inFlightUntil;
  SETTLE_OUTCOME[outcome](state, active, now);
  return true;
}
