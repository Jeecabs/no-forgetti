import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, type AssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { FileReviewAttemptAccounting, type ReviewAttemptAccounting } from "../src/service/accounting.ts";
import { parseReviewCliArgs } from "../src/service/cli.ts";
import { classifyReviewFailure, InMemoryReviewBudgetAccount, ReviewDaemon } from "../src/service/daemon.ts";
import { ReviewDecisionStore } from "../src/service/decisions.ts";
import {
  ModelRunError,
  PiModelRunner,
  type ModelRunHooks,
  type ModelRunRequest,
  type ModelRunResult,
  type ModelRunner,
  type ReviewModelProvenance,
} from "../src/service/model-runner.ts";
import { SQLiteReviewLedger } from "../src/service/ledger.ts";
import { createReviewJob, type ReviewFailure } from "../src/service/protocol.ts";
import { ReviewEngine, ReviewEngineError } from "../src/service/review-engine.ts";
import { ReviewSpool } from "../src/service/spool.ts";
import { DEFAULT_MAX_CHARS, type MemoryBranch } from "../src/types.ts";

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

class CheckpointModelRunner implements ModelRunner {
  calls = 0;
  dispatches = 0;
  private readonly behavior: "completed" | "unknown" | "configuration";

  constructor(behavior: "completed" | "unknown" | "configuration" = "completed") {
    this.behavior = behavior;
  }

  async run(_request: ModelRunRequest, hooks?: ModelRunHooks): Promise<ModelRunResult> {
    this.calls += 1;
    if (this.behavior === "configuration") {
      throw new ModelRunError("auth_unavailable", "Provider is not configured.", { retryable: true });
    }
    await hooks?.beforeDispatch?.({
      provider: provenance.provider,
      model: provenance.model,
      api: provenance.api,
      requestDigest: "1".repeat(64),
      hold: { tokens: 400, costUsd: 0.5 },
    });
    this.dispatches += 1;
    if (this.behavior === "unknown") {
      throw new ModelRunError("provider_error", "Connection lost after dispatch.", { retryable: true });
    }
    await hooks?.observe?.(provenance);
    return { text: '{"operations":[]}', provenance };
  }
}

async function fauxPiModelRunner(
  response: AssistantMessage | ((events: string[]) => AssistantMessage),
  events: string[],
): Promise<{ runner: PiModelRunner; callCount: () => number }> {
  const agentDir = await mkdtemp(join(tmpdir(), "no-forgetti-model-runner-"));
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const faux = fauxProvider();
  faux.setResponses([
    typeof response === "function"
      ? () => response(events)
      : response,
  ]);
  runtime.registerNativeProvider(faux.provider);
  const times = [
    new Date("2026-01-03T00:00:00.000Z"),
    new Date("2026-01-03T00:00:01.000Z"),
  ];
  const runner = new PiModelRunner({
    provider: "faux",
    model: "faux-1",
    reasoningEffort: "off",
    maxCallsPerDay: 1,
    maxTokensPerDay: 1_000,
    maxCostPerDayUsd: 1,
  }, {
    agentDir,
    now: () => times.shift()!,
    createModelRuntime: async () => runtime,
  });
  return { runner, callCount: () => faux.state.callCount };
}

test("model dispatch checkpoint and response observation are awaited in provider order", async () => {
  const events: string[] = [];
  const { runner, callCount } = await fauxPiModelRunner(
    (seen) => {
      seen.push("provider");
      return fauxAssistantMessage("{\"operations\":[]}", { responseId: "response-checkpoint-1" });
    },
    events,
  );
  const hooks: ModelRunHooks = {
    async beforeDispatch(context) {
      assert.equal(context.provider, "faux");
      assert.equal(context.model, "faux-1");
      assert.match(context.requestDigest, /^[0-9a-f]{64}$/u);
      assert.ok(context.hold.tokens > 0);
      assert.ok(context.hold.costUsd >= 0);
      events.push("dispatch:start");
      await Promise.resolve();
      events.push("dispatch:end");
    },
    async observe(observed) {
      events.push(`observe:start:${observed.model}`);
      await Promise.resolve();
      events.push("observe:end");
    },
  };

  const result = await runner.run({ systemPrompt: "system", prompt: "prompt" }, hooks);
  events.push("returned");

  assert.equal(result.text, '{"operations":[]}');
  assert.equal(result.provenance.responseId, "response-checkpoint-1");
  assert.equal(callCount(), 1, "provider retries must remain disabled");
  assert.deepEqual(events, [
    "dispatch:start",
    "dispatch:end",
    "provider",
    "observe:start:faux-1",
    "observe:end",
    "returned",
  ]);
});

test("failed dispatch checkpoint prevents provider execution", async () => {
  const events: string[] = [];
  const { runner, callCount } = await fauxPiModelRunner(fauxAssistantMessage("unused"), events);
  const checkpointError = new Error("durable dispatch checkpoint failed");

  await assert.rejects(
    runner.run({ systemPrompt: "system", prompt: "prompt" }, {
      async beforeDispatch() {
        throw checkpointError;
      },
    }),
    (error: unknown) => error === checkpointError,
  );
  assert.equal(callCount(), 0);
});

test("provider error responses are observed before their provenance error is thrown", async () => {
  const events: string[] = [];
  const { runner, callCount } = await fauxPiModelRunner(
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider overloaded (503)." }),
    events,
  );
  let observed: ReviewModelProvenance | undefined;

  await assert.rejects(
    runner.run({ systemPrompt: "system", prompt: "prompt" }, {
      async beforeDispatch() {
        events.push("dispatch");
      },
      async observe(value) {
        await Promise.resolve();
        observed = value;
        events.push("observed");
      },
    }),
    (error: unknown) => {
      events.push("thrown");
      return error instanceof ModelRunError
        && error.code === "provider_error"
        && error.provenance === observed;
    },
  );

  assert.equal(callCount(), 1);
  assert.deepEqual(events, ["dispatch", "observed", "thrown"]);
});

test("model and auth configuration failures happen before dispatch checkpoint", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "no-forgetti-model-preflight-"));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      checkpoint: {
        baseUrl: "https://review.invalid/v1",
        api: "openai-completions",
        models: [{ id: "reviewer" }],
      },
    },
  }));
  const profile = {
    provider: "checkpoint",
    model: "missing",
    reasoningEffort: "off" as const,
    maxCallsPerDay: 1,
    maxTokensPerDay: 1_000,
    maxCostPerDayUsd: 1,
  };
  const dispatches: string[] = [];
  const hooks: ModelRunHooks = {
    async beforeDispatch() {
      dispatches.push("dispatch");
    },
  };

  await assert.rejects(
    new PiModelRunner(profile, { agentDir }).run({ systemPrompt: "system", prompt: "prompt" }, hooks),
    (error: unknown) => error instanceof ModelRunError && error.code === "model_not_found",
  );
  await assert.rejects(
    new PiModelRunner({ ...profile, model: "reviewer" }, { agentDir })
      .run({ systemPrompt: "system", prompt: "prompt" }, hooks),
    (error: unknown) => error instanceof ModelRunError && error.code === "auth_unavailable",
  );

  assert.deepEqual(dispatches, []);
});

test("review engine forwards daemon checkpoints across its model seam", async () => {
  const events: string[] = [];
  const runner: ModelRunner = {
    async run(_request, hooks) {
      await hooks?.beforeDispatch?.({
        provider: provenance.provider,
        model: provenance.model,
        api: provenance.api,
        requestDigest: "0".repeat(64),
        hold: { tokens: 1, costUsd: 0 },
      });
      events.push("provider");
      await hooks?.observe?.(provenance);
      return { text: '{"operations":[]}', provenance };
    },
  };

  await new ReviewEngine(runner).review(job(), undefined, {
    async beforeDispatch() {
      events.push("dispatch");
    },
    async observe(value) {
      events.push(`observed:${value.model}`);
    },
  });
  events.push("returned");

  assert.deepEqual(events, ["dispatch", "provider", "observed:fake-reviewer", "returned"]);
});

test("review engine defers jobs from a newer memory policy before model dispatch", async () => {
  const incompatibleJob = createReviewJob({
    projectKey: "a".repeat(24),
    sessionId: "private-session-id",
    throughEntryId: "assistant-newer-policy",
    transcript: "USER: remember this durable fact",
    branch,
    maxChars: DEFAULT_MAX_CHARS + 1,
  });
  const runner = new FakeModelRunner({ text: '{"operations":[]}', provenance });

  await assert.rejects(
    new ReviewEngine(runner).review(incompatibleJob),
    (error: unknown) => error instanceof ReviewEngineError
      && error.code === "incompatible_policy"
      && error.retryable,
  );
  assert.equal(runner.requests.length, 0);
  assert.equal(classifyReviewFailure(
    new ReviewEngineError("incompatible_policy", "restart required", { retryable: true }),
  ).configurationBlock, true);
});

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

test("review engine rejects oversized entries before proposal persistence", async () => {
  const runner = new FakeModelRunner({
    text: JSON.stringify({ operations: [{ action: "add", content: "x".repeat(801), importance: "normal" }] }),
    provenance,
  });

  await assert.rejects(
    new ReviewEngine(runner).review(job()),
    (error: unknown) => error instanceof ReviewEngineError
      && error.code === "invalid_proposal"
      && error.retryable
      && error.provenance === provenance
      && /exceeds 800 characters/u.test(error.message),
  );
  assert.equal(runner.requests.length, 1);
});

test("review engine retries a proposal that would consume reserved review headroom", async () => {
  const crowdedBranch: MemoryBranch = {
    ...branch,
    entries: Array.from({ length: 5 }, (_, index) => ({
      id: `crowded-${index}`,
      text: String(index).repeat(800),
      createdAt: branch.createdAt,
      updatedAt: branch.updatedAt,
      importance: "normal" as const,
    })),
  };
  const crowdedJob = createReviewJob({
    projectKey: "a".repeat(24),
    sessionId: "private-session-id",
    throughEntryId: "assistant-crowded",
    transcript: "USER: remember another durable fact",
    branch: crowdedBranch,
    maxChars: DEFAULT_MAX_CHARS,
  });
  const runner = new FakeModelRunner({
    text: JSON.stringify({ operations: [{ action: "add", content: "x".repeat(600), importance: "normal" }] }),
    provenance,
  });

  await assert.rejects(
    new ReviewEngine(runner).review(crowdedJob),
    (error: unknown) => error instanceof ReviewEngineError
      && error.code === "invalid_proposal"
      && error.retryable
      && error.provenance === provenance
      && /working target of 4500 characters/u.test(error.message),
  );
  assert.equal(runner.requests.length, 1);
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

test("oversized first proposal retries before election and a bounded retry commits once", async () => {
  const reviewJob = job();
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-bounded-retry-"));
  let spoolNow = new Date("2026-01-03T12:00:00.000Z");
  const spool = new ReviewSpool(join(root, "spool"), { now: () => spoolNow });
  const accounting = new FileReviewAttemptAccounting(spool.root, { now: () => spoolNow });
  const decisions = new ReviewDecisionStore(spool.root);
  let calls = 0;
  const runner: ModelRunner = {
    async run(_request, hooks) {
      calls += 1;
      const observed = {
        ...provenance,
        responseId: `bounded-retry-${calls}`,
        startedAt: new Date(spoolNow.getTime() - 1_000).toISOString(),
        completedAt: spoolNow.toISOString(),
      };
      await hooks?.beforeDispatch?.({
        provider: observed.provider,
        model: observed.model,
        api: observed.api,
        requestDigest: String(calls).repeat(64),
        hold: { tokens: 400, costUsd: 0.5 },
      });
      await hooks?.observe?.(observed);
      return {
        text: JSON.stringify({ operations: [{
          action: "add",
          content: calls === 1 ? "x".repeat(1_403) : "Keep release notes concise.",
          importance: "normal",
        }] }),
        provenance: observed,
      };
    },
  };
  const committedOperations: unknown[] = [];
  const daemon = new ReviewDaemon({
    spool,
    engine: new ReviewEngine(runner),
    budget: { maxCalls: 3, maxTokens: 3_000, maxCostUsd: 2 },
    attemptAccounting: accounting,
    decisionStore: decisions,
    workerId: "bounded-retry-worker",
    maxAttempts: 2,
    committer: {
      async commit(_job, outcome) {
        committedOperations.push(outcome.status === "completed" ? outcome.operations : []);
        return {
          version: 1,
          proposalId: reviewJob.id,
          jobDigest: reviewJob.digest,
          projectKey: reviewJob.projectKey,
          branchName: reviewJob.branch.name,
          baseBranchDigest: reviewJob.baseBranchDigest,
          status: "applied",
          committedAt: spoolNow.toISOString(),
          resultingBranchDigest: "a".repeat(64),
          messages: ["Memory updated."],
          transactionVersion: 1,
          transactionId: reviewJob.id,
          outcomeDigest: "b".repeat(64),
        };
      },
    },
  });
  await spool.enqueue(reviewJob);

  assert.equal((await daemon.processOne()).status, "retry");
  assert.equal(await decisions.loadDecision(reviewJob.id), undefined);
  assert.deepEqual(committedOperations, []);

  spoolNow = new Date(spoolNow.getTime() + 5_000);
  assert.equal((await daemon.processOne()).status, "completed");
  assert.equal(calls, 2);
  assert.deepEqual(committedOperations, [[{
    action: "add",
    content: "Keep release notes concise.",
    importance: "normal",
  }]]);
  const outcome = await spool.getOutcome(reviewJob.id);
  assert.equal(outcome?.status, "completed");
});

test("durable response checkpoint survives restart without provider rerun or duplicate usage", async () => {
  const reviewJob = job();
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-durable-daemon-"));
  let spoolNow = new Date("2026-01-03T12:00:00.000Z");
  const spool = new ReviewSpool(join(root, "spool"), { now: () => spoolNow });
  const accounting = new FileReviewAttemptAccounting(spool.root, {
    now: () => new Date("2026-01-03T12:00:00.000Z"),
  });
  const decisions = new ReviewDecisionStore(spool.root);
  const runner = new CheckpointModelRunner();
  await spool.enqueue(reviewJob);

  const first = new ReviewDaemon({
    spool,
    engine: new ReviewEngine(runner),
    budget: { maxCalls: 2, maxTokens: 1_000, maxCostUsd: 1 },
    attemptAccounting: accounting,
    decisionStore: decisions,
    workerId: "checkpoint-worker-1",
    committer: { async commit() { throw new Error("simulated crash before admission"); } },
  });
  assert.equal((await first.processOne()).status, "retry");
  assert.equal(runner.dispatches, 1);
  assert.ok(await decisions.loadDecision(reviewJob.id), "response must be durable before admission");

  const noRerun: ModelRunner = {
    async run() { assert.fail("selected durable response must skip provider"); },
  };
  spoolNow = new Date(spoolNow.getTime() + 5_000);
  const second = new ReviewDaemon({
    spool,
    engine: new ReviewEngine(noRerun),
    budget: { maxCalls: 2, maxTokens: 1_000, maxCostUsd: 1 },
    attemptAccounting: accounting,
    decisionStore: decisions,
    workerId: "checkpoint-worker-2",
  });
  assert.equal((await second.processOne()).status, "completed");
  assert.deepEqual((await accounting.snapshot(provenance.provider)).charged, {
    calls: 1,
    tokens: provenance.usage.totalTokens,
    costNanodollars: 3_100_000,
  });
});

test("a permanently failing committer dead-letters the elected decision instead of retrying forever", async () => {
  const reviewJob = job();
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-commit-ceiling-"));
  let spoolNow = new Date("2026-01-03T12:00:00.000Z");
  const spool = new ReviewSpool(join(root, "spool"), { now: () => spoolNow });
  const accounting = new FileReviewAttemptAccounting(spool.root, {
    now: () => new Date("2026-01-03T12:00:00.000Z"),
  });
  const decisions = new ReviewDecisionStore(spool.root);
  const runner = new CheckpointModelRunner();
  await spool.enqueue(reviewJob);

  const deadLetters: ReviewFailure[] = [];
  const broken = (workerId: string) => new ReviewDaemon({
    spool,
    engine: new ReviewEngine(runner),
    budget: { maxCalls: 4, maxTokens: 4_000, maxCostUsd: 1 },
    attemptAccounting: accounting,
    decisionStore: decisions,
    workerId,
    maxAttempts: 2,
    committer: {
      async commit() { throw new Error("committer is permanently broken"); },
      async failed(_failedJob, failure) { deadLetters.push(failure); },
    },
  });

  assert.equal((await broken("ceiling-worker-1").processOne()).status, "retry");
  assert.equal(deadLetters.length, 0, "a retryable pass must not publish a dead-letter");
  spoolNow = new Date(spoolNow.getTime() + 10_000);
  const terminal = await broken("ceiling-worker-2").processOne();
  assert.equal(terminal.status, "failed");
  if (terminal.status === "failed") assert.equal(terminal.failure.retryable, false);
  assert.equal((await spool.getOutcome(reviewJob.id))?.status, "failed");
  assert.equal(runner.dispatches, 1, "the elected decision must never redispatch the provider");
  assert.deepEqual(deadLetters.map((failure) => failure.retryable), [false]);
});

test("legacy terminal failure publishes the dead-letter only after the durable outcome", async () => {
  const reviewJob = job();
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-legacy-deadletter-"));
  const spool = new ReviewSpool(join(root, "spool"));
  await spool.enqueue(reviewJob);
  const deadLetters: ReviewFailure[] = [];
  const daemon = new ReviewDaemon({
    spool,
    engine: new ReviewEngine({
      async run() {
        throw new ModelRunError("provider_error", "Provider exploded.", { retryable: true });
      },
    }),
    budget: { maxCalls: 2, maxTokens: 1_000, maxCostUsd: 1 },
    budgetAccount: new InMemoryReviewBudgetAccount({ now: () => new Date("2026-01-03T12:00:00.000Z") }),
    workerId: "legacy-deadletter-worker",
    maxAttempts: 1,
    committer: {
      async commit() { throw new Error("the dead-letter path must never commit"); },
      async failed(failedJob, failure) {
        assert.equal((await spool.getOutcome(reviewJob.id))?.status, "failed", "spool outcome must be durable before publication");
        assert.equal(failedJob.id, reviewJob.id);
        deadLetters.push(failure);
      },
    },
  });

  assert.equal((await daemon.processOne()).status, "failed");
  assert.deepEqual(deadLetters.map((failure) => failure.retryable), [false]);
});

test("durable provider failure dead-letters through the committer hook exactly once", async () => {
  const reviewJob = job();
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-durable-deadletter-"));
  const spool = new ReviewSpool(join(root, "spool"));
  const accounting = new FileReviewAttemptAccounting(spool.root, {
    now: () => new Date("2026-01-03T12:00:00.000Z"),
  });
  const decisions = new ReviewDecisionStore(spool.root);
  await spool.enqueue(reviewJob);
  const deadLetters: ReviewFailure[] = [];
  const daemon = new ReviewDaemon({
    spool,
    engine: new ReviewEngine(new CheckpointModelRunner("unknown")),
    budget: { maxCalls: 2, maxTokens: 1_000, maxCostUsd: 1 },
    attemptAccounting: accounting,
    decisionStore: decisions,
    workerId: "durable-deadletter-worker",
    maxAttempts: 1,
    committer: {
      async commit() { throw new Error("the dead-letter path must never commit"); },
      async failed(failedJob, failure) {
        assert.equal((await spool.getOutcome(reviewJob.id))?.status, "failed", "spool outcome must be durable before publication");
        assert.equal(failedJob.id, reviewJob.id);
        deadLetters.push(failure);
      },
    },
  });

  assert.equal((await daemon.processOne()).status, "failed");
  assert.deepEqual(deadLetters.map((failure) => failure.retryable), [false]);
});

test("a throwing dead-letter hook never crashes the worker", async () => {
  const reviewJob = job();
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-deadletter-hook-crash-"));
  const spool = new ReviewSpool(join(root, "spool"));
  await spool.enqueue(reviewJob);
  const daemon = new ReviewDaemon({
    spool,
    engine: new ReviewEngine({
      async run() {
        throw new ModelRunError("provider_error", "Provider exploded.", { retryable: true });
      },
    }),
    budget: { maxCalls: 2, maxTokens: 1_000, maxCostUsd: 1 },
    budgetAccount: new InMemoryReviewBudgetAccount({ now: () => new Date("2026-01-03T12:00:00.000Z") }),
    workerId: "deadletter-hook-crash-worker",
    maxAttempts: 1,
    committer: {
      async commit() { throw new Error("the dead-letter path must never commit"); },
      async failed() { throw new Error("feedback mailbox is unavailable"); },
    },
  });

  assert.equal((await daemon.processOne()).status, "failed");
  assert.equal((await spool.getOutcome(reviewJob.id))?.status, "failed");
});

test("decision-before-settlement crash reconciles accounting on restart without provider rerun", async () => {
  const reviewJob = job();
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-decision-settle-failpoint-"));
  let spoolNow = new Date("2026-01-03T12:00:00.000Z");
  const spool = new ReviewSpool(join(root, "spool"), { now: () => spoolNow });
  const authority = new FileReviewAttemptAccounting(spool.root, {
    now: () => new Date("2026-01-03T12:00:00.000Z"),
  });
  const decisions = new ReviewDecisionStore(spool.root);
  let failSettlement = true;
  const accounting: ReviewAttemptAccounting = {
    initialize: () => authority.initialize(),
    reserve: (request) => authority.reserve(request),
    commitDispatch: (reservation) => authority.commitDispatch(reservation),
    async settle(reservation, observed) {
      if (failSettlement) {
        failSettlement = false;
        assert.ok(await decisions.loadDecision(reviewJob.id), "decision must precede settlement");
        throw new Error("simulated crash after decision before settlement");
      }
      await authority.settle(reservation, observed);
    },
    markUnknown: (reservation) => authority.markUnknown(reservation),
    cancelPreDispatch: (reservation) => authority.cancelPreDispatch(reservation),
    snapshot: (provider, day) => authority.snapshot(provider, day),
  };
  const runner = new CheckpointModelRunner();
  await spool.enqueue(reviewJob);

  const first = new ReviewDaemon({
    spool,
    engine: new ReviewEngine(runner),
    budget: { maxCalls: 2, maxTokens: 1_000, maxCostUsd: 1 },
    attemptAccounting: accounting,
    decisionStore: decisions,
    workerId: "decision-settle-worker-1",
    leaseMs: 1,
  });
  await assert.rejects(first.processOne(), /simulated crash after decision before settlement/u);
  assert.equal(runner.dispatches, 1);
  assert.deepEqual((await authority.snapshot(provenance.provider)).held, {
    calls: 1,
    tokens: 400,
    costNanodollars: 500_000_000,
  });

  spoolNow = new Date("2026-01-03T12:00:01.000Z");
  await spool.recover();
  const second = new ReviewDaemon({
    spool,
    engine: new ReviewEngine({ async run() { assert.fail("durable decision must skip provider rerun"); } }),
    budget: { maxCalls: 2, maxTokens: 1_000, maxCostUsd: 1 },
    attemptAccounting: accounting,
    decisionStore: decisions,
    workerId: "decision-settle-worker-2",
  });
  assert.equal((await second.processOne()).status, "completed");
  assert.deepEqual((await authority.snapshot(provenance.provider)).charged, {
    calls: 1,
    tokens: provenance.usage.totalTokens,
    costNanodollars: 3_100_000,
  });
});

test("provider failure checkpoint precedes provenance settlement", async () => {
  const reviewJob = job();
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-failure-settlement-order-"));
  const spool = new ReviewSpool(join(root, "spool"));
  const authority = new FileReviewAttemptAccounting(spool.root, {
    now: () => new Date("2026-01-03T12:00:00.000Z"),
  });
  const decisions = new ReviewDecisionStore(spool.root);
  const accounting: ReviewAttemptAccounting = {
    initialize: () => authority.initialize(),
    reserve: (request) => authority.reserve(request),
    commitDispatch: (reservation) => authority.commitDispatch(reservation),
    async settle(reservation, observed) {
      const checkpoint = await decisions.loadAttempt(reviewJob.id, reservation.id);
      assert.equal(checkpoint?.outcome.status, "failed", "failed provider result must precede settlement");
      await authority.settle(reservation, observed);
    },
    markUnknown: (reservation) => authority.markUnknown(reservation),
    cancelPreDispatch: (reservation) => authority.cancelPreDispatch(reservation),
    snapshot: (provider, day) => authority.snapshot(provider, day),
  };
  const runner: ModelRunner = {
    async run(_request, hooks) {
      await hooks?.beforeDispatch?.({
        provider: provenance.provider,
        model: provenance.model,
        api: provenance.api,
        requestDigest: "2".repeat(64),
        hold: { tokens: 400, costUsd: 0.5 },
      });
      await hooks?.observe?.(provenance);
      throw new ModelRunError("provider_error", "Provider rejected response.", {
        retryable: true,
        provenance,
      });
    },
  };
  await spool.enqueue(reviewJob);
  const daemon = new ReviewDaemon({
    spool,
    engine: new ReviewEngine(runner),
    budget: { maxCalls: 2, maxTokens: 1_000, maxCostUsd: 1 },
    attemptAccounting: accounting,
    decisionStore: decisions,
    workerId: "failure-order-worker",
  });

  assert.equal((await daemon.processOne()).status, "retry");
  assert.deepEqual((await authority.snapshot(provenance.provider)).charged, {
    calls: 1,
    tokens: provenance.usage.totalTokens,
    costNanodollars: 3_100_000,
  });
});

test("SQLite shadow records valid provider state transitions and selected decision", async () => {
  const reviewJob = job();
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-daemon-shadow-"));
  const spool = new ReviewSpool(join(root, "spool"));
  const accounting = new FileReviewAttemptAccounting(spool.root, {
    now: () => new Date("2026-01-03T12:00:00.000Z"),
  });
  const decisions = new ReviewDecisionStore(spool.root);
  const ledger = new SQLiteReviewLedger(join(root, "ledger.sqlite"));
  await spool.enqueue(reviewJob);
  const daemon = new ReviewDaemon({
    spool,
    engine: new ReviewEngine(new CheckpointModelRunner()),
    budget: { maxCalls: 2, maxTokens: 1_000, maxCostUsd: 1 },
    attemptAccounting: accounting,
    decisionStore: decisions,
    ledger,
    workerId: "shadow-worker",
  });

  assert.equal((await daemon.processOne()).status, "completed");
  const attempts = ledger.providerAttempts(reviewJob.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.state, "settled");
  assert.equal(attempts[0]?.requestDigest, "1".repeat(64));
  assert.equal(attempts[0]?.selected, true);
  ledger.close();
});

test("SQLite shadow omits request digest from canceled pre-dispatch attempt", async () => {
  const reviewJob = job();
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-daemon-canceled-shadow-"));
  const spool = new ReviewSpool(join(root, "spool"));
  const authority = new FileReviewAttemptAccounting(spool.root, {
    now: () => new Date("2026-01-03T12:00:00.000Z"),
  });
  const accounting: ReviewAttemptAccounting = {
    initialize: () => authority.initialize(),
    reserve: (request) => authority.reserve(request),
    async commitDispatch() { throw new Error("dispatch checkpoint failpoint"); },
    settle: (reservation, observed) => authority.settle(reservation, observed),
    markUnknown: (reservation) => authority.markUnknown(reservation),
    cancelPreDispatch: (reservation) => authority.cancelPreDispatch(reservation),
    snapshot: (provider, day) => authority.snapshot(provider, day),
  };
  const decisions = new ReviewDecisionStore(spool.root);
  const ledger = new SQLiteReviewLedger(join(root, "ledger.sqlite"));
  await spool.enqueue(reviewJob);
  const daemon = new ReviewDaemon({
    spool,
    engine: new ReviewEngine(new CheckpointModelRunner()),
    budget: { maxCalls: 2, maxTokens: 1_000, maxCostUsd: 1 },
    attemptAccounting: accounting,
    decisionStore: decisions,
    ledger,
    workerId: "canceled-shadow-worker",
  });

  assert.equal((await daemon.processOne()).status, "retry");
  const attempts = ledger.providerAttempts(reviewJob.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.state, "canceled");
  assert.equal(attempts[0]?.requestDigest, undefined);
  ledger.close();
});

test("drain stops after deferred configuration retry", async () => {
  const reviewJob = job();
  const now = new Date().toISOString();
  const claim = {
    job: reviewJob,
    attempt: 1,
    workerId: "drain-config-worker",
    leaseToken: "c".repeat(32),
    claimedAt: now,
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
  };
  let claims = 0;
  let defers = 0;
  const budget = new InMemoryReviewBudgetAccount();
  const daemon = new ReviewDaemon({
    spool: {
      async initialize() {},
      async recover() {},
      async claim() {
        claims += 1;
        if (claims > 1) throw new Error("drain reclaimed deferred retry in same pass");
        return claim;
      },
      async renew() { return claim; },
      async finish() { assert.fail("configuration retry must not finish job"); },
      async defer() { defers += 1; },
    },
    engine: new ReviewEngine(new CheckpointModelRunner("configuration")),
    budget: { maxCalls: 2, maxTokens: 1_000, maxCostUsd: 1 },
    budgetAccount: budget,
    workerId: "drain-config-worker",
  });

  assert.deepEqual(await daemon.drain(), {
    completed: 0,
    failed: 0,
    retried: 1,
    budgetExhausted: false,
    interrupted: false,
  });
  assert.equal(claims, 1);
  assert.equal(defers, 1);
  assert.equal((await budget.snapshot()).calls, 0);
});

test("configuration preflight checkpoints failure, reserves nothing, and defers with backoff", async () => {
  const reviewJob = job();
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-config-checkpoint-"));
  let spoolNow = new Date("2026-01-03T12:00:00.000Z");
  const spool = new ReviewSpool(join(root, "spool"), { now: () => spoolNow });
  const accounting = new FileReviewAttemptAccounting(spool.root, {
    now: () => new Date("2026-01-03T12:00:00.000Z"),
  });
  const decisions = new ReviewDecisionStore(spool.root);
  const runner = new CheckpointModelRunner("configuration");
  await spool.enqueue(reviewJob);
  const daemon = new ReviewDaemon({
    spool,
    engine: new ReviewEngine(runner),
    budget: { maxCalls: 1, maxTokens: 1_000, maxCostUsd: 1 },
    attemptAccounting: accounting,
    decisionStore: decisions,
    workerId: "config-checkpoint-worker",
  });

  const result = await daemon.processOne();
  assert.equal(result.status, "retry");
  assert.equal(runner.dispatches, 0);
  assert.deepEqual((await accounting.snapshot(provenance.provider)).effective, {
    calls: 0,
    tokens: 0,
    costNanodollars: 0,
  });
  assert.equal((await readdir(join(spool.root, "provider-results", reviewJob.id))).length, 1);
  assert.equal(await spool.claim({ workerId: "config-checkpoint-verifier", leaseMs: 1_000 }), undefined);
  spoolNow = new Date(spoolNow.getTime() + 60_000);
  const retried = await spool.claim({ workerId: "config-checkpoint-verifier", leaseMs: 1_000 });
  assert.equal(retried?.attempt, 2, "defer must become claimable after durable backoff");
});

test("dispatched failure holds unknown usage and reports later attempt exhaustion distinctly", async () => {
  const reviewJob = job();
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-unknown-attempt-"));
  let spoolNow = new Date("2026-01-03T12:00:00.000Z");
  const spool = new ReviewSpool(join(root, "spool"), { now: () => spoolNow });
  const accounting = new FileReviewAttemptAccounting(spool.root, {
    now: () => new Date("2026-01-03T12:00:00.000Z"),
  });
  const decisions = new ReviewDecisionStore(spool.root);
  const runner = new CheckpointModelRunner("unknown");
  await spool.enqueue(reviewJob);
  const daemon = new ReviewDaemon({
    spool,
    engine: new ReviewEngine(runner),
    budget: { maxCalls: 1, maxTokens: 1_000, maxCostUsd: 1 },
    attemptAccounting: accounting,
    decisionStore: decisions,
    workerId: "unknown-attempt-worker",
  });

  assert.equal((await daemon.processOne()).status, "retry");
  assert.deepEqual((await accounting.snapshot(provenance.provider)).unknown, {
    calls: 1,
    tokens: 400,
    costNanodollars: 500_000_000,
  });
  spoolNow = new Date(spoolNow.getTime() + 5_000);
  const exhausted = await daemon.processOne();
  assert.equal(exhausted.status, "attempt_budget_exhausted");
  if (exhausted.status === "attempt_budget_exhausted") {
    assert.equal(exhausted.provider, provenance.provider);
    assert.deepEqual(exhausted.usage.effective, exhausted.usage.unknown);
  }
  assert.equal(runner.dispatches, 1, "exhausted reservation must stop provider dispatch");
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
          transactionVersion: 1 as const,
          transactionId: reviewJob.id,
          outcomeDigest: "0".repeat(64),
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

test("configuration blocks remain retryable beyond attempt limit without consuming call budget", async () => {
  const reviewJob = job();
  const now = new Date().toISOString();
  const claim = {
    job: reviewJob,
    attempt: 8,
    workerId: "config-worker",
    leaseToken: "b".repeat(32),
    claimedAt: now,
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
  };
  const budget = new InMemoryReviewBudgetAccount();
  const daemon = new ReviewDaemon({
    spool: {
      async initialize() {},
      async recover() {},
      async claim() { return claim; },
      async renew() { return claim; },
      async finish() { assert.fail("configuration block must remain unacknowledged"); },
    },
    engine: new ReviewEngine({
      async run() {
        throw new ModelRunError("auth_unavailable", "Provider is not configured.", { retryable: true });
      },
    }),
    budget: { maxCalls: 100, maxTokens: 1_000, maxCostUsd: 1 },
    budgetAccount: budget,
    workerId: "config-worker",
    maxAttempts: 3,
  });

  const result = await daemon.processOne();
  assert.equal(result.status, "retry");
  assert.equal(result.status === "retry" && result.failure.code, "auth_unavailable");
  assert.equal((await budget.snapshot()).calls, 0);
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
