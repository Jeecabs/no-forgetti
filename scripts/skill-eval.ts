#!/usr/bin/env node

import type {
  ModelDispatchContext,
  ModelRunHooks,
  ModelRunRequest,
  ModelRunResult,
  ModelRunner,
  ReviewModelProvenance,
} from "../src/service/model-runner.ts";
import { PiModelRunner } from "../src/service/model-runner.ts";
import {
  compareSkillEvalCandidates,
  parseSkillEvalCliArgs,
  publicSkillEvalReport,
  reviewerProfileFromSkillEval,
  runSkillEvalCandidates,
  scoreSkillEvalReplay,
} from "../src/skill-eval.ts";
import { SKILL_EVAL_CASES } from "../evals/skill-authoring/cases.ts";

interface BudgetLimits {
  maxCalls: number;
  maxTokens: number;
  maxCostUsd: number;
}

interface BudgetReservation {
  tokens: number;
  costUsd: number;
  settled: boolean;
}

class LiveEvalBudget {
  calls = 0;
  tokens = 0;
  costUsd = 0;
  readonly limits: BudgetLimits;

  constructor(limits: BudgetLimits) {
    this.limits = limits;
  }

  reserve(context: ModelDispatchContext): BudgetReservation {
    if (this.calls + 1 > this.limits.maxCalls) throw new Error("Skill eval call budget exhausted before dispatch.");
    if (this.tokens + context.hold.tokens > this.limits.maxTokens) {
      throw new Error("Skill eval token budget exhausted before dispatch.");
    }
    if (this.costUsd + context.hold.costUsd > this.limits.maxCostUsd) {
      throw new Error("Skill eval cost budget exhausted before dispatch.");
    }
    this.calls += 1;
    this.tokens += context.hold.tokens;
    this.costUsd += context.hold.costUsd;
    return { tokens: context.hold.tokens, costUsd: context.hold.costUsd, settled: false };
  }

  settle(reservation: BudgetReservation, provenance: ReviewModelProvenance): void {
    if (reservation.settled) throw new Error("Skill eval budget reservation settled twice.");
    reservation.settled = true;
    this.tokens += provenance.usage.totalTokens - reservation.tokens;
    this.costUsd += provenance.usage.cost.total - reservation.costUsd;
    if (this.tokens > this.limits.maxTokens || this.costUsd > this.limits.maxCostUsd) {
      throw new Error("Skill eval provider usage exceeded its conservative dispatch hold.");
    }
  }
}

class BudgetedRunner implements ModelRunner {
  private readonly runner: ModelRunner;
  private readonly budget: LiveEvalBudget;

  constructor(runner: ModelRunner, budget: LiveEvalBudget) {
    this.runner = runner;
    this.budget = budget;
  }

  async run(request: ModelRunRequest, hooks: ModelRunHooks = {}): Promise<ModelRunResult> {
    let reservation: BudgetReservation | undefined;
    return this.runner.run(request, {
      beforeDispatch: async (context) => {
        reservation = this.budget.reserve(context);
        await hooks.beforeDispatch?.(context);
      },
      observe: async (provenance) => {
        if (!reservation) throw new Error("Skill eval model usage arrived without a budget reservation.");
        this.budget.settle(reservation, provenance);
        await hooks.observe?.(provenance);
      },
    });
  }
}

async function main(args: readonly string[]): Promise<void> {
  const options = parseSkillEvalCliArgs(args);
  const maximumAttempts = SKILL_EVAL_CASES.length * options.profiles.length * 2;
  if (options.maxCalls < maximumAttempts) {
    throw new Error(`--max-calls must allow the shared worst-case ${maximumAttempts} attempts.`);
  }
  const budget = new LiveEvalBudget({
    maxCalls: options.maxCalls,
    maxTokens: options.maxTokens,
    maxCostUsd: options.maxCostUsd,
  });
  const candidates = options.profiles.map((profile) => ({
    id: profile.id,
    profile: {
      provider: profile.provider,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      maxOutputTokens: options.maxOutputTokens,
    },
    runner: new BudgetedRunner(
      new PiModelRunner(reviewerProfileFromSkillEval(profile, options), {
        maxOutputTokens: options.maxOutputTokens,
      }),
      budget,
    ),
  }));
  const replays = await runSkillEvalCandidates(SKILL_EVAL_CASES, candidates);
  const reports = replays.map((replay) => scoreSkillEvalReplay(SKILL_EVAL_CASES, replay));
  const baseline = reports[0]!;
  const comparisons = reports.slice(1).map((candidate) => compareSkillEvalCandidates(baseline, candidate));
  const report = {
    ...publicSkillEvalReport(reports, comparisons),
    liveBudget: {
      calls: budget.calls,
      tokens: budget.tokens,
      costUsd: budget.costUsd,
      limits: budget.limits,
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (comparisons.some(({ recommendation }) => recommendation !== "admit")) process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`Skill eval failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
