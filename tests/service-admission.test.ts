import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectMemoryStore } from "../src/store.ts";
import { FileMemoryProposalCommitter } from "../src/service/admission.ts";
import { createReviewJob, createReviewOutcome, type ReviewModelProvenance } from "../src/service/protocol.ts";

const provenance: ReviewModelProvenance = {
  provider: "fake",
  model: "reviewer",
  api: "fake-api",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  durationMs: 1_000,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), "no-forgetti-admission-"));
  const project = join(base, "repo");
  const agentDir = join(base, "agent");
  await mkdir(join(project, ".git"), { recursive: true });
  const store = new ProjectMemoryStore(project, { storageRoot: agentDir });
  await store.initialize();
  t.after(() => rm(base, { recursive: true, force: true }));
  return { agentDir, store };
}

test("external admission applies a proposal once through branch CAS", async (t) => {
  const { agentDir, store } = await fixture(t);
  const branch = await store.loadBranch("main");
  const job = createReviewJob({
    projectKey: store.projectKey,
    sessionId: "private-session",
    throughEntryId: "entry-1",
    transcript: "USER: remember the canonical check",
    branch,
    baseBranchDigest: store.branchDigest(branch),
    maxChars: store.maxChars,
  });
  const outcome = createReviewOutcome(job, {
    status: "completed",
    operations: [{ action: "add", content: "Canonical verification uses pnpm check.", importance: "high" }],
    provenance,
    completedAt: provenance.completedAt,
  });
  const committer = new FileMemoryProposalCommitter(agentDir);
  const receipt = await committer.commit(job, outcome);
  assert.equal(receipt.status, "applied");
  assert.deepEqual((await store.loadBranch("main")).entries.map((entry) => entry.text), [
    "Canonical verification uses pnpm check.",
  ]);

  const duplicate = await committer.commit(job, outcome);
  assert.deepEqual(duplicate, receipt);
  assert.equal((await store.loadBranch("main")).entries.length, 1);
});

test("external admission records stale proposals without overwriting foreground memory", async (t) => {
  const { agentDir, store } = await fixture(t);
  const branch = await store.loadBranch("main");
  const job = createReviewJob({
    projectKey: store.projectKey,
    sessionId: "private-session",
    throughEntryId: "entry-1",
    transcript: "USER: remember this",
    branch,
    baseBranchDigest: store.branchDigest(branch),
    maxChars: store.maxChars,
  });
  await store.applyOperation("main", { action: "add", content: "Later foreground fact." });
  const outcome = createReviewOutcome(job, {
    status: "completed",
    operations: [{ action: "add", content: "Stale reviewed fact.", importance: "normal" }],
    provenance,
    completedAt: provenance.completedAt,
  });
  const receipt = await new FileMemoryProposalCommitter(agentDir).commit(job, outcome);
  assert.equal(receipt.status, "stale");
  assert.deepEqual((await store.loadBranch("main")).entries.map((entry) => entry.text), ["Later foreground fact."]);
});
