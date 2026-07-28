import {
  MEMORY_MAINTENANCE_GOAL_RATIO,
  MEMORY_REFINEMENT_TARGET_RATIO,
} from "./types.ts";

export interface MemoryPolicyLimits {
  hardLimit: number;
  workingTarget: number;
  maintenanceGoal: number;
}

/** Single source of truth for bounded memory review thresholds. */
export function memoryPolicy(maxChars: number): MemoryPolicyLimits {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("Memory policy requires a positive integer limit.");
  return {
    hardLimit: maxChars,
    workingTarget: Math.max(1, Math.floor(maxChars * MEMORY_REFINEMENT_TARGET_RATIO)),
    maintenanceGoal: Math.max(1, Math.floor(maxChars * MEMORY_MAINTENANCE_GOAL_RATIO)),
  };
}

function hardLimitViolation(afterChars: number, hardLimit: number): string | undefined {
  return afterChars > hardLimit
    ? `Proposal would exceed the ${hardLimit}-character hard limit (${afterChars}/${hardLimit}).`
    : undefined;
}

function workingTargetViolation(request: {
  beforeChars: number;
  afterChars: number;
  workingTarget: number;
}): string | undefined {
  const { beforeChars, afterChars, workingTarget } = request;
  if (beforeChars < workingTarget) {
    return afterChars > workingTarget
      ? `Proposal would exceed the working target of ${workingTarget} characters (${afterChars}/${workingTarget}).`
      : undefined;
  }
  return afterChars > beforeChars
    ? `Proposal cannot grow at or above the ${workingTarget}-character working target (${beforeChars}→${afterChars}). Consolidate, remove, or return no operations.`
    : undefined;
}

/** Returns the deterministic admission failure, or undefined when the review fits. */
export function reviewCapacityViolation(request: {
  beforeChars: number;
  afterChars: number;
  maxChars: number;
}): string | undefined {
  const policy = memoryPolicy(request.maxChars);
  return hardLimitViolation(request.afterChars, policy.hardLimit)
    ?? workingTargetViolation({ ...request, workingTarget: policy.workingTarget });
}
