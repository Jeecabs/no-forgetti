import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseReviewCliArgs } from "../src/service/cli.ts";
import { classifyReviewFailure, InMemoryReviewBudgetAccount, ReviewDaemon } from "../src/service/daemon.ts";
import {
  ModelRunError,
  type ModelRunRequest,
  type ModelRunResult,
  type ModelRunner,
  type ReviewModelProvenance,
} from "../src/service/model-runner.ts";
import { createReviewJob } from "../src/service/protocol.ts";
import { ReviewEngine, ReviewEngineError } from "../src/service/review-engine.ts";
import { ReviewSpool } from "../src/service/spool.ts";
import type { MemoryBranch } from "../src/types.ts";

const branch: MemoryBranch = {
  version: 1,
  name: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  entries: [{
    id: "entry-one",
    text: "Package commands use pnpm.",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    importance: "normal",
  }],
};

const provenance: ReviewModelProvenance = {
  provider: "fake-provider",
  model: "fake-reviewer",
  api: "fake-api",
  responseModel: "fake-reviewer-2026-01",
  startedAt: "2026-01-03T00:00:00.000Z",
  completedAt: "2026-01-03T00:00:01.000Z",
  durationMs: 1_000,
  usage: {
    input: 120,
    output: 30,
    cacheRead: 10,
    cacheWrite: 0,
    totalTokens: 160,
    cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 },
  },
};

function job() {
  return createReviewJob({
    projectKey: "a".repeat(24),
    sessionId: "private-session-id",
    throughEntryId: "assistant-9",
    transcript: "USER: Correction: always run pnpm check before finishing.",
    branch,
    maxChars: 4_000,
  });
}

class FakeModelRunner implements ModelRunner {
  readonly requests: ModelRunRequest[] = [];
  private readonly result: ModelRunResult;

  constructor(result: ModelRunResult) {
    this.result = result;
  }

  async run(request: ModelRunRequest): Promise<ModelRunResult> {
    this.requests.push(request);
    return this.result;
  }
}

test("tool-less review engine builds prompt from job and returns typed proposal with provenance", async () => {
  const reviewJob = job();
  const original = structuredClone(reviewJob);
  const runner = new FakeModelRunner({
    text: JSON.stringify({ operations: [{ action: "add", content: "Run pnpm check before finishing.", importance: "high" }] }),
    provenance,
  });
  const proposal = await new ReviewEngine(runner).review(reviewJob);

  assert.deepEqual(proposal.plan, {
    operations: [{ action: "add", content: "Run pnpm check before finishing.", importance: "high" }],
  });
  assert.equal(proposal.jobId, reviewJob.id);
  assert.equal(proposal.jobDigest, reviewJob.digest);
  assert.deepEqual(proposal.provenance, provenance);
  assert.deepEqual(reviewJob, original, "review worker must not mutate job memory snapshot");

  assert.equal(runner.requests.length, 1);
  const request = runner.requests[0]!;
  assert.match(request.systemPrompt, /no tools/u);
  assert.match(request.systemPrompt, /untrusted data/u);
  assert.match(request.prompt, /Correction: always run pnpm check/u);
  assert.match(request.prompt, /Package commands use pnpm/u);
  assert.match(request.prompt, new RegExp(reviewJob.id, "u"));
  assert.doesNotMatch(request.prompt, /private-session-id/u);
  assert.equal(Object.hasOwn(request, "tools"), false);
});

test("review engine rejects malformed or unsafe model proposals and retains call provenance", async () => {
  const malformed = new ReviewEngine(new FakeModelRunner({ text: "not-json", provenance }));
  await assert.rejects(
    malformed.review(job()),
    (error: unknown) => error instanceof ReviewEngineError
      && error.code === "invalid_model_output"
      && error.retryable
      && error.provenance === provenance,
  );

  const unsafe = new ReviewEngine(new FakeModelRunner({
    text: JSON.stringify({ operations: [{ action: "add", content: "API_KEY=super-secret-token-value", importance: "high" }] }),
    provenance,
  }));
  await assert.rejects(
    unsafe.review(job()),
    (error: unknown) => error instanceof ReviewEngineError
      && error.code === "invalid_proposal"
      && error.provenance === provenance,
  );
});

test("daemon drains spool into proposal outcome without a memory mutation interface", async () => {
  const reviewJob = job();
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-runtime-"));
  const spool = new ReviewSpool(join(root, "spool"));
  await spool.enqueue(reviewJob);
  const runner = new FakeModelRunner({ text: '{"operations":[]}', provenance });
  const budget = new InMemoryReviewBudgetAccount({ now: () => new Date("2026-01-03T12:00:00.000Z") });
  const daemon = new ReviewDaemon({
    spool,
    engine: new ReviewEngine(runner),
    budget: { maxCalls: 2, maxTokens: 1_000, maxCostUsd: 1 },
    budgetAccount: budget,
    workerId: "test-worker",
    leaseMs: 10_000,
  });

  assert.deepEqual(await daemon.drain(), {
    completed: 1,
    failed: 0,
    retried: 0,
    budgetExhausted: false,
    interrupted: false,
  });
  const outcome = await spool.getOutcome(reviewJob.id);
  assert.equal(outcome?.status, "completed");
  if (outcome?.status === "completed") {
    assert.deepEqual(outcome.operations, []);
    assert.deepEqual(outcome.provenance, provenance);
  }
  assert.deepEqual(await budget.snapshot(), {
    day: "2026-01-03",
    calls: 1,
    tokens: 160,
    costUsd: 0.0031,
  });
});

test("daemon keeps renewing its lease through proposal admission", async () => {
  const reviewJob = job();
  const claimedAt = new Date().toISOString();
  const claim = {
    job: reviewJob,
    attempt: 1,
    workerId: "lease-worker",
    leaseToken: "a".repeat(32),
    claimedAt,
    leaseUntil: new Date(Date.now() + 15).toISOString(),
  };
  let available = true;
  let renewals = 0;
  let finished = false;
  const spool = {
    async initialize() {},
    async recover() {},
    async claim() {
      if (!available) return undefined;
      available = false;
      return claim;
    },
    async renew() {
      renewals += 1;
      return { ...claim, leaseUntil: new Date(Date.now() + 15).toISOString() };
    },
    async finish() {
      finished = true;
    },
  };
  const daemon = new ReviewDaemon({
    spool,
    engine: new ReviewEngine(new FakeModelRunner({ text: '{"operations":[]}', provenance })),
    budget: { maxCalls: 2, maxTokens: 1_000, maxCostUsd: 1 },
    workerId: "lease-worker",
    leaseMs: 15,
    committer: {
      async commit() {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          version: 1 as const,
          proposalId: reviewJob.id,
          jobDigest: reviewJob.digest,
          projectKey: reviewJob.projectKey,
          branchName: reviewJob.branch.name,
          baseBranchDigest: reviewJob.baseBranchDigest,
          status: "noop" as const,
          committedAt: new Date().toISOString(),
          resultingBranchDigest: reviewJob.baseBranchDigest,
          messages: [],
        };
      },
    },
  });

  assert.equal((await daemon.processOne()).status, "completed");
  assert.equal(finished, true);
  assert.ok(renewals > 0, "admission must stay inside the fenced lease");
});

test("daemon checks daily budgets before claiming work", async () => {
  const reviewJob = job();
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-budget-"));
  const spool = new ReviewSpool(join(root, "spool"));
  await spool.enqueue(reviewJob);
  const runner = new FakeModelRunner({ text: '{"operations":[]}', provenance });
  const budget = new InMemoryReviewBudgetAccount({
    now: () => new Date("2026-01-03T12:00:00.000Z"),
    initial: { day: "2026-01-03", calls: 1, tokens: 0, costUsd: 0 },
  });
  const daemon = new ReviewDaemon({
    spool,
    engine: new ReviewEngine(runner),
    budget: { maxCalls: 1, maxTokens: 1_000, maxCostUsd: 1 },
    budgetAccount: budget,
    workerId: "budget-worker",
  });

  assert.deepEqual(await daemon.processOne(), {
    status: "budget_exhausted",
    usage: { day: "2026-01-03", calls: 1, tokens: 0, costUsd: 0 },
  });
  assert.equal(runner.requests.length, 0);
  assert.ok(await spool.claim({ workerId: "verification-worker", leaseMs: 1_000 }), "budget stop must not claim a job");
});

test("daemon classifies missing auth as a configuration-blocked retry", () => {
  const failure = classifyReviewFailure(new ModelRunError(
    "auth_unavailable",
    "API_KEY=super-secret-token-value",
    { retryable: true },
  ));
  assert.deepEqual(failure, {
    code: "auth_unavailable",
    message: "API_KEY=[REDACTED]",
    retryable: true,
    configurationBlock: true,
  });
});

test("review CLI exposes explicit one-shot drain mode without credential flags", () => {
  assert.deepEqual(parseReviewCliArgs([
    "review", "--once", "--worker-id", "worker-1", "--lease-ms", "1000", "--max-attempts", "4",
  ]), {
    command: "review",
    once: true,
    help: false,
    workerId: "worker-1",
    leaseMs: 1_000,
    maxAttempts: 4,
  });
  assert.throws(() => parseReviewCliArgs(["review", "--api-key", "secret"]), /Unknown review option/u);
});
