import assert from "node:assert/strict";
import test from "node:test";

import { ModelRunError, type ModelRunRequest, type ModelRunResult, type ModelRunner } from "../src/service/model-runner.ts";
import type { SkillAuthorshipPacket } from "../src/skill-authorship-packet.ts";
import { SkillReviewEngine } from "../src/skill-review-engine.ts";
import { createSkillReviewJob } from "../src/skill-review-job.ts";

function packet(): SkillAuthorshipPacket {
  return {
    version: 1,
    kind: "skill-authorship",
    conventions: { memory: [] },
    coverage: {
      frontierEntryId: "user-1",
      includedUserEntryIds: ["user-1"],
      eligibleUserEntryIds: ["user-1"],
      userTurns: 1,
      truncated: false,
      cursorStatus: "from-start",
    },
    evidence: {
      transcript: "USER: Going forward, use the repeatable release verification workflow.",
      invokedSkillNames: [],
      actions: [{ kind: "command", command: "pnpm check", outcome: "completed" }],
      redactionCount: 0,
    },
    corpus: {
      activeTotal: 0,
      catalog: [],
      documents: [],
      catalogOmitted: 0,
      documentsOmitted: 0,
      pendingTotal: 0,
      pending: [],
      pendingOmitted: 0,
      truncated: false,
    },
  };
}

function result(text: string, ordinal: number): ModelRunResult {
  return {
    text,
    provenance: {
      provider: "test",
      model: "reviewer",
      api: "test-api",
      responseId: `response-${ordinal}`,
      startedAt: `2026-01-01T00:00:0${ordinal}.000Z`,
      completedAt: `2026-01-01T00:00:0${ordinal}.100Z`,
      durationMs: 100,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  };
}

class SequenceRunner implements ModelRunner {
  readonly requests: ModelRunRequest[] = [];
  private readonly responses: string[];

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async run(request: ModelRunRequest): Promise<ModelRunResult> {
    this.requests.push(request);
    return result(this.responses[this.requests.length - 1]!, this.requests.length);
  }
}

function job() {
  return createSkillReviewJob({
    projectKey: "a".repeat(24),
    sessionId: "session",
    claimGeneration: 1,
    packet: packet(),
  });
}

test("skill review engine retries one invalid response and returns a grounded typed outcome", async () => {
  const runner = new SequenceRunner([
    "{}",
    JSON.stringify({ operations: [{
      action: "create",
      name: "release-verification",
      description: "Verify releases with the canonical project checks.",
      content: "# Release verification\n\n1. Run `pnpm check`. Done when: it exits successfully.",
      reason: "Going forward, use the repeatable release verification workflow.",
      evidence: ["ACTION command completed: pnpm check"],
    }] }),
  ]);
  const reviewJob = job();
  const before = JSON.stringify(reviewJob);
  const outcome = await new SkillReviewEngine(runner).review(reviewJob);

  assert.equal(outcome.disposition, "proposed");
  assert.equal(outcome.plan.operations.at(0)?.name, "release-verification");
  assert.equal(outcome.attempts.length, 2);
  assert.match(runner.requests[1]!.prompt, /previous output was invalid/u);
  assert.equal(outcome.attempts[0]?.validationErrorCode, "invalid_output");
  assert.equal(outcome.attempts[1]?.provenance.responseId, "response-2");
  assert.equal(JSON.stringify(reviewJob), before);
});

test("skill review engine distinguishes malformed exhaustion from a valid abstention", async () => {
  const malformed = await new SkillReviewEngine(new SequenceRunner(["not json", "still not json"])).review(job());
  const abstention = await new SkillReviewEngine(new SequenceRunner(['{"operations":[]}'])).review(job());

  assert.equal(malformed.disposition, "invalid-output");
  assert.deepEqual(malformed.plan, { operations: [] });
  assert.equal(malformed.attempts.length, 2);
  assert.equal(abstention.disposition, "no-change");
  assert.equal(abstention.attempts.length, 1);
});

test("skill review engine returns typed runner failures without converting them to no-change", async () => {
  const runner: ModelRunner = {
    async run() {
      throw new ModelRunError("provider_error", "private provider detail", { retryable: true });
    },
  };
  const outcome = await new SkillReviewEngine(runner).review(job());

  assert.equal(outcome.disposition, "runner-failure");
  assert.equal(outcome.failure?.code, "provider_error");
  assert.equal(outcome.failure?.retryable, true);
  assert.deepEqual(outcome.plan, { operations: [] });
  assert.equal(JSON.stringify(outcome).includes("private provider detail"), false);
});
