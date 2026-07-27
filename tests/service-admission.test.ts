import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectMemoryStore } from "../src/store.ts";
import { admissionBindingDigest, FileMemoryProposalCommitter } from "../src/service/admission.ts";
import { consumeReviewFeedback, ReviewFeedbackInbox, type ReviewFeedback } from "../src/service/feedback.ts";
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

  const admissionEntries = await readdir(join(store.projectDir, "review-admissions"), { withFileTypes: true });
  assert.deepEqual(admissionEntries.filter((entry) => entry.isFile()).map((entry) => entry.name), []);
  const retiredFiles = await readdir(join(store.projectDir, "review-admissions", "retired"));
  assert.deepEqual(retiredFiles, [`${job.id}.json`]);
  const tombstone = await readFile(join(store.projectDir, "review-admissions", "retired", retiredFiles[0]!), "utf8");
  assert.doesNotMatch(tombstone, /private-session|canonical check|Canonical verification/u);
  assert.equal(await store.getReviewAdmissionResult(job.id), undefined);
  assert.equal(
    (await store.getReviewAdmissionMetadata(job.id, admissionBindingDigest(job, outcome)))?.resultingBranchDigest,
    receipt.resultingBranchDigest,
  );
});

test("external admission feedback reports actual added, changed, and removed content", async (t) => {
  const { agentDir, store } = await fixture(t);
  const first = await store.applyOperation("main", { action: "add", content: "Tests run with pnpm test." });
  const second = await store.applyOperation("main", { action: "add", content: "CI runs on Node 18." });
  const branch = await store.loadBranch("main");
  const testsId = first.branch.entries.at(0)!.id;
  const ciId = second.branch.entries.at(1)!.id;
  const job = createReviewJob({
    projectKey: store.projectKey,
    sessionId: "private-session",
    throughEntryId: "entry-1",
    transcript: "USER: update project verification",
    branch,
    baseBranchDigest: store.branchDigest(branch),
    maxChars: store.maxChars,
  });
  const outcome = createReviewOutcome(job, {
    status: "completed",
    operations: [
      { action: "replace", entryId: testsId, content: "Tests run with pnpm check.", importance: "high" },
      { action: "remove", entryId: ciId },
      { action: "add", content: "Deploys use the release workflow.", importance: "normal" },
    ],
    provenance,
    completedAt: provenance.completedAt,
  });

  const inbox = new ReviewFeedbackInbox(store.projectDir);
  await inbox.initialize();
  await inbox.register(job.id, job.digest);
  const receipt = await new FileMemoryProposalCommitter(agentDir).commit(job, outcome);
  const feedback: ReviewFeedback[] = [];
  assert.equal(await consumeReviewFeedback(inbox, (value) => feedback.push(value)), 1);
  assert.deepEqual(feedback, [{
    version: 1,
    jobId: job.id,
    jobDigest: job.digest,
    branchName: "main",
    status: "applied",
    messages: receipt.messages,
    changes: [
      { kind: "add", text: "Deploys use the release workflow." },
      { kind: "replace", text: "Tests run with pnpm check.", oldText: "Tests run with pnpm test." },
      { kind: "remove", text: "CI runs on Node 18." },
    ],
  }]);
  assert.equal(await consumeReviewFeedback(inbox, (value) => feedback.push(value)), 0);
});

test("receipt recovery reuses a committed store transaction instead of reporting stale", async (t) => {
  const { agentDir, store } = await fixture(t);
  const branch = await store.loadBranch("main");
  const job = createReviewJob({
    projectKey: store.projectKey,
    sessionId: "private-session",
    throughEntryId: "entry-1",
    transcript: "USER: remember the recovery check",
    branch,
    baseBranchDigest: store.branchDigest(branch),
    maxChars: store.maxChars,
  });
  const outcome = createReviewOutcome(job, {
    status: "completed",
    operations: [{ action: "add", content: "Recovery keeps the original admission.", importance: "high" }],
    provenance,
    completedAt: provenance.completedAt,
  });

  const committed = await store.applyReviewAdmission({
    transactionId: job.id,
    branchName: "main",
    expectedBranchDigest: job.baseBranchDigest,
    bindingDigest: admissionBindingDigest(job, outcome),
    operations: outcome.status === "completed" ? outcome.operations : [],
  });
  assert.equal(committed.status, "applied");
  await store.applyOperation("main", { action: "add", content: "Later foreground memory remains visible." });

  const receipt = await new FileMemoryProposalCommitter(agentDir).commit(job, outcome);
  assert.equal(receipt.status, "applied");
  assert.equal(receipt.resultingBranchDigest, committed.resultingBranchDigest);
  assert.equal(receipt.revisionId, committed.revisionId);
  assert.equal((await readdir(join(store.projectDir, "revisions", "main"))).length, 1);
  assert.deepEqual((await store.loadBranch("main")).entries.map((entry) => entry.text), [
    "Recovery keeps the original admission.",
    "Later foreground memory remains visible.",
  ]);
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
