import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileReviewAttemptAccounting } from "../src/service/accounting.ts";
import { readReviewServiceMonitor, ReviewWorkerStatusReporter } from "../src/service/monitor.ts";
import { formatReviewServiceMonitorText } from "../src/service/tui.ts";

async function fixture() {
  const agentDir = await mkdtemp(join(tmpdir(), "no-forgetti-monitor-"));
  const root = join(agentDir, "no-forgetti");
  await mkdir(join(root, "review-spool", "queued"), { recursive: true });
  await mkdir(join(root, "review-spool", "running"), { recursive: true });
  await mkdir(join(root, "review-spool", "outcomes"), { recursive: true });
  await mkdir(join(root, "review-spool", "dead-letter"), { recursive: true });
  await writeFile(join(root, "service.json"), JSON.stringify({
    version: 1,
    mode: "external",
    evidenceTtlHours: 24,
    reviewer: {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      maxCallsPerDay: 100,
      maxTokensPerDay: 500_000,
      maxCostPerDayUsd: 10,
    },
  }));
  return { agentDir, root };
}

test("service monitor exposes queue, worker heartbeat, and exhausted dimensions", async () => {
  const { agentDir, root } = await fixture();
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  await writeFile(join(root, "review-budget.json"), JSON.stringify({
    version: 1,
    day,
    calls: 100,
    tokens: 1234,
    costUsd: 0.25,
  }));
  await writeFile(join(root, "review-spool", "queued", "one.json"), "{}");
  await writeFile(join(root, "review-spool", "outcomes", "done.json"), "{}");

  const reporter = new ReviewWorkerStatusReporter(agentDir, "monitor-worker", now);
  reporter.start();
  reporter.record({ type: "claimed", jobId: `review_${"a".repeat(40)}`, attempt: 2 });
  await reporter.flush();

  const monitor = await readReviewServiceMonitor(agentDir, new Date(now.getTime() + 1_000));
  assert.equal(monitor.workerFresh, true);
  assert.equal(monitor.workerCompatible, true);
  assert.equal(monitor.worker?.state, "working");
  assert.equal(monitor.worker?.memoryPolicyVersion, 1);
  assert.equal(monitor.worker?.maxMemoryChars, 6_000);
  assert.equal(monitor.worker?.attempt, 2);
  assert.deepEqual(monitor.spool, { queued: 1, running: 0, outcomes: 1, deadLetter: 0 });
  assert.deepEqual(monitor.exhausted, ["calls"]);
  assert.match(formatReviewServiceMonitorText(monitor, {
    projectRoot: "/project",
    branch: "main",
    entries: 2,
    usedChars: 120,
    maxChars: 4_000,
  }), /calls: 100\/100/u);
});

test("service monitor exposes settled, held, and unknown attempt accounting", async () => {
  const { agentDir, root } = await fixture();
  const now = new Date();
  const accounting = new FileReviewAttemptAccounting(join(root, "review-spool"), { now: () => now });
  const reservation = await accounting.reserve({
    claim: { jobDigest: "a".repeat(64), attempt: 1, leaseToken: "b".repeat(32) },
    provider: "openai-codex",
    limits: { maxCalls: 100, maxTokens: 500_000, maxCostNanodollars: 10_000_000_000 },
    hold: { tokens: 32_000, costNanodollars: 500_000_000 },
  });
  assert.ok(reservation);
  await accounting.commitDispatch(reservation);
  await accounting.markUnknown(reservation);

  const monitor = await readReviewServiceMonitor(agentDir, now);
  assert.equal(monitor.budget.calls, 1);
  assert.equal(monitor.budget.tokens, 32_000);
  assert.equal(monitor.budget.unknown?.calls, 1);
  assert.equal(monitor.budget.held?.calls, 0);
  assert.match(formatReviewServiceMonitorText(monitor, {
    projectRoot: "/project",
    branch: "main",
    entries: 0,
    usedChars: 0,
    maxChars: 4_000,
  }), /0 settled · 0 held · 1 unknown/u);
});

test("worker heartbeat preserves retry state", async () => {
  const { agentDir } = await fixture();
  const now = new Date();
  const reporter = new ReviewWorkerStatusReporter(agentDir, "retry-worker", now);
  reporter.start();
  reporter.record({
    type: "retry",
    jobId: `review_${"b".repeat(40)}`,
    attempt: 3,
    failure: { code: "auth_unavailable", message: "auth unavailable", retryable: true },
  });
  reporter.heartbeat();
  await reporter.flush();

  const monitor = await readReviewServiceMonitor(agentDir, new Date(now.getTime() + 1_000));
  assert.equal(monitor.worker?.state, "waiting-retry");
  assert.equal(monitor.workerFresh, true);
});

test("service monitor marks a legacy worker without policy provenance incompatible", async () => {
  const { agentDir, root } = await fixture();
  const now = new Date();
  await mkdir(join(root, "review-workers"), { recursive: true });
  await writeFile(join(root, "review-workers", `${"a".repeat(24)}.json`), JSON.stringify({
    version: 1,
    workerId: "legacy-worker",
    pid: 123,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    state: "idle",
  }));

  const monitor = await readReviewServiceMonitor(agentDir, new Date(now.getTime() + 1_000));
  assert.equal(monitor.workerFresh, true);
  assert.equal(monitor.workerCompatible, false);
});

test("service monitor marks stale and stopped workers offline", async () => {
  const { agentDir } = await fixture();
  const now = new Date();
  const reporter = new ReviewWorkerStatusReporter(agentDir, "monitor-worker", now);
  reporter.start();
  reporter.stop();
  await reporter.flush();

  const monitor = await readReviewServiceMonitor(agentDir, new Date(now.getTime() + 31_000));
  assert.equal(monitor.worker?.state, "stopped");
  assert.equal(monitor.workerFresh, false);
});
