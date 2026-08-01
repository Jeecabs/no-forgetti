import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import type { ModelRunHooks, ModelRunRequest, ModelRunResult, ModelRunner } from "../src/service/model-runner.ts";
import {
  compareSkillEvalCandidates,
  parseSkillEvalCliArgs,
  publicSkillEvalReport,
  runSkillEvalCandidates,
  scoreSkillEvalReplay,
} from "../src/skill-eval.ts";
import { SKILL_EVAL_CASES } from "../evals/skill-authoring/cases.ts";

function modelResult(text: string, ordinal: number, model: string): ModelRunResult {
  return {
    text,
    provenance: {
      provider: "test",
      model,
      api: "test-api",
      responseId: `${model}-${ordinal}`,
      startedAt: `2026-01-01T00:00:${String(ordinal).padStart(2, "0")}.000Z`,
      completedAt: `2026-01-01T00:00:${String(ordinal).padStart(2, "0")}.100Z`,
      durationMs: 100,
      usage: {
        input: 20,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 30,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      },
    },
  };
}

class SequenceRunner implements ModelRunner {
  readonly requests: ModelRunRequest[] = [];
  private readonly responses: string[];
  private readonly model: string;

  constructor(model: string, responses: string[]) {
    this.model = model;
    this.responses = responses;
  }

  async run(request: ModelRunRequest, hooks: ModelRunHooks = {}): Promise<ModelRunResult> {
    this.requests.push(request);
    const text = this.responses[this.requests.length - 1];
    if (text === undefined) throw new Error(`Missing ${this.model} replay output.`);
    await hooks.beforeDispatch?.({
      provider: "test",
      model: this.model,
      api: "test-api",
      requestDigest: createHash("sha256").update(`${request.systemPrompt}\n${request.prompt}`).digest("hex"),
      hold: { tokens: 100, costUsd: 0.01 },
    });
    const result = modelResult(text, this.requests.length, this.model);
    await hooks.observe?.(result.provenance);
    return result;
  }
}

const GOOD_OUTPUTS = [
  JSON.stringify({ operations: [{
    action: "create",
    name: "release-verification",
    description: "Release verification runs for recurring project releases.",
    content: "# Release verification\n\n1. Run pnpm check. Done when: the command exits successfully.",
    reason: "Going forward, every release uses the recurring release verification workflow with pnpm check.",
    evidence: ["pnpm check completed successfully."],
  }] }),
  JSON.stringify({ operations: [{
    action: "patch",
    name: "verification",
    oldText: "pnpm check",
    newText: "pnpm test",
    reason: "Correction: the canonical verification command is now pnpm test instead of pnpm check.",
    evidence: ["pnpm test completed successfully."],
  }] }),
  JSON.stringify({ operations: [{
    action: "archive",
    name: "old-deploy",
    reason: "The old-deploy workflow is obsolete and fully replaced.",
    evidence: ["Archive it; it must no longer be invoked."],
  }] }),
  '{"operations":[]}',
  '{"operations":[]}',
  JSON.stringify({ operations: [{
    action: "create",
    name: "deploy-by-environment",
    description: "Environment-aware deployment runs for recurring staging and production releases.",
    content: "# Environment-aware deployment\n\n1. Identify the target environment.\n2. If staging, run pnpm deploy:staging.\n3. If production, run pnpm deploy:production.\n4. Verify deployment health. Done when: the selected command succeeds and health checks pass.",
    reason: "Going forward, use an environment-aware deployment workflow: if staging run pnpm deploy:staging; if production run pnpm deploy:production; then verify health.",
    evidence: ["Both environment commands and health verification completed in their respective branches."],
  }] }),
  JSON.stringify({ operations: [{
    action: "create",
    name: "release-notes",
    description: "Use when asked to prepare recurring release notes.",
    content: "# Release notes\n\n1. Collect merged changes.\n2. Group user-visible items.\n3. Verify issue links. Done when: every user-visible change is categorized and linked.",
    reason: "Whenever I ask to prepare release notes, use the recurring workflow: collect merged changes, group user-visible items, and verify issue links.",
    evidence: ["collect merged changes, group user-visible items, and verify issue links."],
  }] }),
  JSON.stringify({ operations: [{
    action: "create",
    name: "rollback-drill",
    description: "Rollback drills rehearse recurring restoration of a prior version.",
    content: "# Rollback drill\n\n1. Rehearse the rollback.\n2. Restore the prior version.\n3. Verify recovery with health checks. Done when: the prior version is healthy.",
    reason: "Add a separate recurring rollback drill. It is distinct from deploy verification: rehearse rollback, restore the prior version, and verify recovery.",
    evidence: ["Do not merge these workflows."],
  }] }),
  JSON.stringify({ operations: [{
    action: "create",
    name: "credential-rotation",
    description: "Credential rotation runs for recurring approved credential changes.",
    content: "# Credential rotation\n\n1. Rotate the credential through the approved provider.\n2. Update only the secret reference without recording its value.\n3. Run pnpm credentials:verify. Done when: verification succeeds without exposing a credential.",
    reason: "Make our recurring credential-rotation checklist durable.",
    evidence: ["The reference update and verification completed without exposing a credential."],
  }] }),
  JSON.stringify({ operations: [{
    action: "patch",
    name: "release-checks",
    oldText: "pnpm check",
    newText: "pnpm verify",
    reason: "The existing release-checks workflow is the same durable procedure; patch its canonical command from pnpm check to pnpm verify.",
    evidence: ["pnpm verify completed successfully."],
  }] }),
  JSON.stringify({ operations: [{
    action: "patch",
    name: "ci-triage",
    oldText: "Investigate continuous integration failures.",
    newText: "Use when asked to investigate recurring continuous integration failures.",
    reason: "Keep ci-triage, but make its invocation explicit: use it when asked to investigate recurring continuous integration failures.",
    evidence: ["make its invocation explicit: use it when asked"],
  }] }),
  JSON.stringify({ operations: [{
    action: "patch",
    name: "deploy-target",
    oldText: "2. Run pnpm deploy.",
    newText: "2. If staging, run pnpm deploy:staging.\n3. If production, run pnpm deploy:production.",
    reason: "Replace the single deploy command with explicit branches: staging uses pnpm deploy:staging and production uses pnpm deploy:production.",
    evidence: ["Keep the health completion criterion."],
  }] }),
  JSON.stringify({ operations: [{
    action: "patch",
    name: "large-runbook",
    oldText: "Operate the large recurring service runbook.",
    newText: "Use when asked to operate the recurring large service runbook.",
    reason: "The large-runbook body is omitted, so change only its visible description.",
    evidence: ["It should say to use it when asked to operate the recurring large service runbook."],
  }] }),
  JSON.stringify({ operations: [{
    action: "archive",
    name: "release-verify-old",
    reason: "release-verify-old is a duplicate fully superseded by release-verification.",
    evidence: ["Archive only release-verify-old and keep the canonical skill."],
  }] }),
  JSON.stringify({ operations: [{
    action: "archive",
    name: "legacy-ci-trigger",
    reason: "The legacy-ci-trigger invocation is retired with its provider.",
    evidence: ["it must never trigger on CI investigation requests again."],
  }] }),
  JSON.stringify({ operations: [{
    action: "archive",
    name: "production-only-deploy",
    reason: "production-only-deploy is obsolete because deploy-by-environment replaced its production-only branch.",
    evidence: ["Archive production-only-deploy."],
  }] }),
  JSON.stringify({ operations: [{
    action: "archive",
    name: "leaked-token-helper",
    reason: "Its unsafe retired credential handling exposed",
    evidence: ["it must never be invoked again."],
  }] }),
  '{"operations":[]}',
  '{"operations":[]}',
  '{"operations":[]}',
  '{"operations":[]}',
  '{"operations":[]}',
  '{"operations":[]}',
  '{"operations":[]}',
  '{"operations":[]}',
  '{"operations":[]}',
  '{"operations":[]}',
  '{"operations":[]}',
  '{"operations":[]}',
  '{"operations":[]}',
  '{"operations":[]}',
];

const BAD_OUTPUTS = SKILL_EVAL_CASES.map(() => '{"operations":[]}');

function candidate(id: string, runner: ModelRunner) {
  return {
    id,
    profile: { provider: "test", model: id, reasoningEffort: "medium" as const, maxOutputTokens: 4096 },
    runner,
  };
}

test("frozen semantic corpus covers every decision class without raw secrets", () => {
  assert.deepEqual(SKILL_EVAL_CASES.map(({ expectation }) => expectation.action), [
    "create", "patch", "archive", "no-change", "no-change",
    "create", "create", "create", "create",
    "patch", "patch", "patch", "patch",
    "archive", "archive", "archive", "archive",
    "no-change", "no-change", "no-change",
    "no-change", "no-change", "no-change", "no-change", "no-change", "no-change",
    "no-change", "no-change", "no-change", "no-change", "no-change",
  ]);
  assert.equal(SKILL_EVAL_CASES.length, 31);
  assert.deepEqual(
    Object.fromEntries(["create", "patch", "archive", "no-change"].map((action) => [
      action,
      SKILL_EVAL_CASES.filter(({ expectation }) => expectation.action === action).length,
    ])),
    { create: 5, patch: 5, archive: 5, "no-change": 16 },
  );
  assert.equal(SKILL_EVAL_CASES.filter(({ risk }) => risk === "critical").length >= 5, true);
  const labels = SKILL_EVAL_CASES.map(({ id }) => id);
  assert.equal(new Set(labels).size, SKILL_EVAL_CASES.length);
  for (const requiredLabel of [
    "near-duplicate",
    "omitted-body",
    "failed-command",
    "one-off",
    "hypothetical",
    "invocation-only",
    "missing-archive-target",
    "missing-patch-target",
    "secret",
    "redacted",
    "adversarial",
    "description-trigger",
    "branch",
    "completion",
  ]) {
    assert.equal(labels.some((label) => label.includes(requiredLabel)), true, `missing ${requiredLabel} corpus label`);
  }
  assert.equal(SKILL_EVAL_CASES.every(({ job }) => Object.isFrozen(job) && Object.isFrozen(job.packet)), true);
  const serialized = JSON.stringify(SKILL_EVAL_CASES);
  assert.doesNotMatch(serialized, /API_KEY\s*=|\bsk-[A-Za-z0-9]{12,}/u);
  assert.match(serialized, /\[REDACTED\]/u);
});

test("deterministic replay scoring separates good and bad semantic candidates", async () => {
  const goodRunner = new SequenceRunner("good", GOOD_OUTPUTS);
  const badRunner = new SequenceRunner("bad", BAD_OUTPUTS);
  const [goodReplay, badReplay] = await runSkillEvalCandidates(SKILL_EVAL_CASES, [
    candidate("good", goodRunner),
    candidate("bad", badRunner),
  ]);

  assert.deepEqual(
    goodReplay.cases.map(({ jobId }) => jobId),
    badReplay.cases.map(({ jobId }) => jobId),
    "every candidate receives the same immutable jobs in the same order",
  );
  const good = scoreSkillEvalReplay(SKILL_EVAL_CASES, goodReplay);
  const bad = scoreSkillEvalReplay(SKILL_EVAL_CASES, badReplay);

  assert.equal(good.cases.every(({ passed }) => passed), true);
  assert.equal(good.summary.passedCases, SKILL_EVAL_CASES.length);
  assert.equal(good.summary.noChangeCases, 16);
  assert.equal(good.summary.noChangePassed, 16);
  assert.ok(good.summary.noChangePrecisionLowerBound > 0.8);
  assert.equal(good.summary.expectedProposalCases, 15);
  assert.equal(good.summary.predictedProposals, 15);
  assert.equal(good.summary.correctProposals, 15);
  assert.ok(good.summary.proposalPrecisionLowerBound > 0.75);
  assert.equal(good.provenance.attempts, SKILL_EVAL_CASES.length);
  assert.equal(good.provenance.totalTokens, SKILL_EVAL_CASES.length * 30);
  assert.ok(Math.abs(good.provenance.costUsd - SKILL_EVAL_CASES.length * 0.003) < 1e-12);
  assert.equal(bad.summary.passedCases < good.summary.passedCases, true);
  assert.equal(bad.cases.find(({ caseId }) => caseId === "create-release-verification")?.invocation.score, 0);
  assert.ok((bad.cases.find(({ caseId }) => caseId === "patch-verification-command")?.downstream.score ?? 1) < 1);

  const safeReport = JSON.stringify(publicSkillEvalReport([good, bad], []));
  assert.doesNotMatch(safeReport, /"plan"|"operations"|pnpm check|Going forward|\[REDACTED\]/u);
  assert.match(safeReport, /"provenance"|"totalTokens"/u);

  const promotion = compareSkillEvalCandidates(bad, good);
  assert.equal(promotion.recommendation, "admit");
  assert.equal(promotion.regressions.length, 0);
  assert.ok(promotion.improvements.length > 0);
  assert.deepEqual(promotion.gateFailures, []);

  const regression = compareSkillEvalCandidates(good, bad);
  assert.equal(regression.recommendation, "hold");
  assert.ok(regression.regressions.length > 0);

  const unaccounted = scoreSkillEvalReplay(SKILL_EVAL_CASES, { ...goodReplay, dispatches: [] });
  const accountingHold = compareSkillEvalCandidates(bad, unaccounted);
  assert.equal(accountingHold.recommendation, "hold");
  assert.ok(accountingHold.gateFailures.includes("missing-dispatch-accounting"));

  const tamperedCases = goodReplay.cases.map((item, index) => {
    if (index !== 0 || !("outcome" in item)) return item;
    return {
      ...item,
      outcome: {
        ...item.outcome,
        attempts: item.outcome.attempts.map((attempt) => ({
          ...attempt,
          provenance: { ...attempt.provenance, model: "other-reviewer" },
        })),
      },
    };
  });
  const unattested = scoreSkillEvalReplay(SKILL_EVAL_CASES, { ...goodReplay, cases: tamperedCases });
  assert.equal(compareSkillEvalCandidates(bad, unattested).recommendation, "hold");
  assert.equal(unattested.dispatch.complete, false);
});

test("replay scorer rejects missing, duplicate, or mismatched jobs", async () => {
  const [replay] = await runSkillEvalCandidates(SKILL_EVAL_CASES, [candidate(
    "good",
    new SequenceRunner("good", GOOD_OUTPUTS),
  )]);
  assert.throws(
    () => scoreSkillEvalReplay(SKILL_EVAL_CASES, { ...replay, cases: replay.cases.slice(1) }),
    /same frozen case jobs/u,
  );
  assert.throws(
    () => scoreSkillEvalReplay(SKILL_EVAL_CASES, { ...replay, cases: [...replay.cases, replay.cases[0]!] }),
    /same frozen case jobs/u,
  );
  assert.throws(
    () => scoreSkillEvalReplay(SKILL_EVAL_CASES, {
      ...replay,
      cases: replay.cases.map((item, index) => index === 0 ? { ...item, jobDigest: "0".repeat(64) } : item),
    }),
    /job digest/u,
  );
});

test("live CLI requires explicit candidate profiles and hard budgets", () => {
  assert.throws(() => parseSkillEvalCliArgs([]), /--live/u);
  assert.throws(
    () => parseSkillEvalCliArgs(["--live", "--candidate", "only", "--provider", "test", "--model", "one"]),
    /reasoning|at least two|budget/u,
  );
  const parsed = parseSkillEvalCliArgs([
    "--live",
    "--candidate", "baseline", "--provider", "openai", "--model", "model-a", "--reasoning", "medium",
    "--candidate", "challenger", "--provider", "openai", "--model", "model-b", "--reasoning", "high",
    "--max-calls", "20", "--max-tokens", "100000", "--max-cost-usd", "5", "--max-output-tokens", "4096",
  ]);

  assert.deepEqual(parsed.profiles.map(({ id, provider, model, reasoningEffort }) => ({ id, provider, model, reasoningEffort })), [
    { id: "baseline", provider: "openai", model: "model-a", reasoningEffort: "medium" },
    { id: "challenger", provider: "openai", model: "model-b", reasoningEffort: "high" },
  ]);
  assert.equal(parsed.maxCalls, 20);
  assert.equal(parsed.maxTokens, 100000);
  assert.equal(parsed.maxCostUsd, 5);
  assert.equal(parsed.maxOutputTokens, 4096);
  assert.equal(Object.hasOwn(parsed, "serviceConfig"), false);
});
