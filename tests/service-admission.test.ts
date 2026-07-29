import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
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

test("external admission enforces the capacity carried by an older producer job", async (t) => {
  const { agentDir, store } = await fixture(t);
  for (const content of ["a", "b", "c", "d", "e"]) {
    await store.applyOperation("main", { action: "add", content: content.repeat(700) });
  }
  await store.applyOperation("main", { action: "add", content: "f".repeat(257) });
  const branch = await store.loadBranch("main");
  assert.equal(branch.entries.reduce((total, entry) => total + entry.text.length, 0), 3_757);
  const job = createReviewJob({
    projectKey: store.projectKey,
    sessionId: "private-session",
    throughEntryId: "entry-policy",
    transcript: "USER: remember the academic grant package",
    branch,
    baseBranchDigest: store.branchDigest(branch),
    maxChars: 4_000,
  });
  const outcome = createReviewOutcome(job, {
    status: "completed",
    operations: [{ action: "add", content: "g".repeat(395), importance: "normal" }],
    provenance,
    completedAt: provenance.completedAt,
  });

  const receipt = await new FileMemoryProposalCommitter(agentDir).commit(job, outcome);

  assert.equal(receipt.status, "noop");
  assert.match(receipt.messages.at(0) ?? "", /4000-character hard limit \(4152\/4000\)/u);
  assert.equal((await store.loadBranch("main")).entries.length, 6);
});

test("external admission safely no-ops a proposal that consumes review headroom", async (t) => {
  const { agentDir, store } = await fixture(t);
  for (const content of ["a", "b", "c", "d", "e"]) {
    await store.applyOperation("main", { action: "add", content: content.repeat(800) });
  }
  await store.applyOperation("main", { action: "add", content: "f".repeat(500) });
  const branch = await store.loadBranch("main");
  const job = createReviewJob({
    projectKey: store.projectKey,
    sessionId: "private-session",
    throughEntryId: "entry-1",
    transcript: "USER: remember one more fact",
    branch,
    baseBranchDigest: store.branchDigest(branch),
    maxChars: store.maxChars,
  });
  const outcome = createReviewOutcome(job, {
    status: "completed",
    operations: [{ action: "add", content: "One more durable fact.", importance: "normal" }],
    provenance,
    completedAt: provenance.completedAt,
  });

  const receipt = await new FileMemoryProposalCommitter(agentDir).commit(job, outcome);

  assert.equal(receipt.status, "noop");
  assert.match(receipt.messages.at(0) ?? "", /Review batch skipped/u);
  assert.equal((await store.loadBranch("main")).entries.length, 6);
  await assert.rejects(readdir(join(store.projectDir, "revisions", "main")), /ENOENT/u);
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
  await inbox.register({ jobId: job.id, jobDigest: job.digest });
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

const terminalFailure = { code: "provider_error", message: "Provider exploded.", retryable: false };
const WEEK_AGO = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);

function jobFor(store: ProjectMemoryStore, branch: Awaited<ReturnType<ProjectMemoryStore["loadBranch"]>>, throughEntryId: string) {
  return createReviewJob({
    projectKey: store.projectKey,
    sessionId: "private-session",
    throughEntryId,
    transcript: `USER: remember ${throughEntryId}`,
    branch,
    baseBranchDigest: store.branchDigest(branch),
    maxChars: store.maxChars,
  });
}

test("feedback registration accepts matching legacy interest before richer presentation metadata", async (t) => {
  const { store } = await fixture(t);
  const branch = await store.loadBranch("main");
  const job = jobFor(store, branch, "legacy-interest");
  const inbox = new ReviewFeedbackInbox(store.projectDir);
  await inbox.initialize();
  await inbox.register({ jobId: job.id, jobDigest: job.digest });
  await inbox.register({
    jobId: job.id,
    jobDigest: job.digest,
    branchName: "main",
    requestedBy: "manual",
    queuedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.deepEqual(await inbox.listPending(), [{ version: 1, jobId: job.id, jobDigest: job.digest }]);
});

test("dead-letter feedback publishes only registered interest and is idempotent", async (t) => {
  const { agentDir, store } = await fixture(t);
  const branch = await store.loadBranch("main");
  const job = jobFor(store, branch, "entry-1");
  const committer = new FileMemoryProposalCommitter(agentDir);
  const inbox = new ReviewFeedbackInbox(store.projectDir);
  await inbox.initialize();

  await committer.failed(job, terminalFailure);
  assert.equal(await consumeReviewFeedback(inbox, () => assert.fail("unregistered job must publish nothing")), 0);

  await inbox.register({ jobId: job.id, jobDigest: job.digest });
  await committer.failed(job, terminalFailure);
  await committer.failed(job, terminalFailure);
  const feedback: ReviewFeedback[] = [];
  assert.equal(await consumeReviewFeedback(inbox, (value) => feedback.push(value)), 1);
  assert.deepEqual(feedback, [{
    version: 1,
    jobId: job.id,
    jobDigest: job.digest,
    branchName: "main",
    status: "failed",
    messages: ["Provider exploded."],
    changes: [],
  }]);
});

test("dead-letter publication never overwrites an earlier admission publication", async (t) => {
  const { agentDir, store } = await fixture(t);
  const branch = await store.loadBranch("main");
  const job = jobFor(store, branch, "entry-1");
  const outcome = createReviewOutcome(job, {
    status: "completed",
    operations: [{ action: "add", content: "Applied before the dead-letter.", importance: "normal" }],
    provenance,
    completedAt: provenance.completedAt,
  });
  const committer = new FileMemoryProposalCommitter(agentDir);
  const inbox = new ReviewFeedbackInbox(store.projectDir);
  await inbox.initialize();
  await inbox.register({ jobId: job.id, jobDigest: job.digest });

  await committer.commit(job, outcome);
  await committer.failed(job, terminalFailure);
  const feedback: ReviewFeedback[] = [];
  assert.equal(await consumeReviewFeedback(inbox, (value) => feedback.push(value)), 1);
  assert.equal(feedback.at(0)?.status, "applied");
  assert.deepEqual(feedback.at(0)?.changes, [{ kind: "add", text: "Applied before the dead-letter." }]);
});

test("aged orphan pending interest is garbage collected while fresh interest survives", async (t) => {
  const { store } = await fixture(t);
  const branch = await store.loadBranch("main");
  const agedJob = jobFor(store, branch, "aged-entry");
  const freshJob = jobFor(store, branch, "fresh-entry");
  const inbox = new ReviewFeedbackInbox(store.projectDir);
  await inbox.initialize();
  await inbox.register({ jobId: agedJob.id, jobDigest: agedJob.digest });
  await inbox.register({ jobId: freshJob.id, jobDigest: freshJob.digest });
  await utimes(join(inbox.pendingDir, `${agedJob.id}.json`), WEEK_AGO, WEEK_AGO);

  assert.equal(await consumeReviewFeedback(inbox, () => assert.fail("nothing is ready for delivery")), 0);
  assert.deepEqual(await readdir(inbox.pendingDir), [`${freshJob.id}.json`]);
});

test("aged pending interest with a ready publication is delivered, not collected", async (t) => {
  const { agentDir, store } = await fixture(t);
  const branch = await store.loadBranch("main");
  const job = jobFor(store, branch, "entry-1");
  const inbox = new ReviewFeedbackInbox(store.projectDir);
  await inbox.initialize();
  await inbox.register({ jobId: job.id, jobDigest: job.digest });
  await new FileMemoryProposalCommitter(agentDir).failed(job, terminalFailure);
  await utimes(join(inbox.pendingDir, `${job.id}.json`), WEEK_AGO, WEEK_AGO);

  const feedback: ReviewFeedback[] = [];
  assert.equal(await consumeReviewFeedback(inbox, (value) => feedback.push(value)), 1);
  assert.equal(feedback.at(0)?.status, "failed");
  assert.deepEqual(await readdir(inbox.pendingDir), []);
  assert.deepEqual(await readdir(inbox.readyDir), []);
});

test("a wedged mailbox of aged orphans self-heals without parsing them", async (t) => {
  const { store } = await fixture(t);
  const inbox = new ReviewFeedbackInbox(store.projectDir);
  await inbox.initialize();
  for (let index = 0; index < 1_025; index += 1) {
    const path = join(inbox.pendingDir, `review_${index.toString(16).padStart(40, "0")}.json`);
    await writeFile(path, "not even json");
    await utimes(path, WEEK_AGO, WEEK_AGO);
  }

  assert.equal(await consumeReviewFeedback(inbox, () => assert.fail("nothing is deliverable")), 0);
  assert.deepEqual(await readdir(inbox.pendingDir), []);
});

test("aged ready litter without pending interest is swept", async (t) => {
  const { store } = await fixture(t);
  const inbox = new ReviewFeedbackInbox(store.projectDir);
  await inbox.initialize();
  const path = join(inbox.readyDir, `review_${"a".repeat(40)}.json`);
  await writeFile(path, "orphaned ready record");
  await utimes(path, WEEK_AGO, WEEK_AGO);

  assert.equal(await consumeReviewFeedback(inbox, () => assert.fail("nothing is deliverable")), 0);
  assert.deepEqual(await readdir(inbox.readyDir), []);
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
