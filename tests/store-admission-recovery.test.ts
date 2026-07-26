import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { memoryBranchDigest, ProjectMemoryStore } from "../src/store.ts";

async function fixture(options: ConstructorParameters<typeof ProjectMemoryStore>[1] = {}) {
  const base = await mkdtemp(join(tmpdir(), "no-forgetti-store-admission-"));
  const project = join(base, "repo");
  const storage = join(base, "state");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, ".git"), "gitdir: elsewhere\n", "utf8");
  const store = new ProjectMemoryStore(project, { ...options, storageRoot: storage });
  await store.initialize();
  return { base, project, storage, store };
}

const TRANSACTION_ID = `review_${"a".repeat(40)}`;

test("external review admission recovers its frozen branch and exact revision after an intent-only crash", async (t) => {
  let crashed = false;
  const { base, project, storage, store } = await fixture({
    now: () => new Date("2026-07-01T12:00:00.000Z"),
    admissionFailpoint: (phase) => {
      if (!crashed && phase === "intent-written") {
        crashed = true;
        throw new Error("simulated crash after intent");
      }
    },
  });
  t.after(() => rm(base, { recursive: true, force: true }));
  const original = await store.applyOperation("main", { action: "add", content: "Original durable fact." });
  const expectedBranchDigest = memoryBranchDigest(original.branch);
  const entryId = original.branch.entries.at(0)!.id;

  await assert.rejects(store.applyReviewAdmission({
    transactionId: TRANSACTION_ID,
    branchName: "main",
    expectedBranchDigest,
    operations: [{ action: "replace", entryId, content: "Reviewed durable fact.", importance: "high" }],
  }), /simulated crash/u);
  assert.deepEqual((await store.loadBranch("main")).entries.map((entry) => entry.text), ["Reviewed durable fact."]);

  const recoveredStore = new ProjectMemoryStore(project, { storageRoot: storage });
  await recoveredStore.initialize();
  const recovered = await recoveredStore.getReviewAdmissionResult(TRANSACTION_ID);
  assert.ok(recovered);
  assert.equal(recovered.status, "applied");
  assert.equal(recovered.committedAt, "2026-07-01T12:00:00.000Z");
  assert.deepEqual(recovered.messages, ["Memory replaced."]);
  assert.deepEqual(recovered.branch.entries.map((entry) => entry.text), ["Reviewed durable fact."]);
  assert.equal(recovered.resultingBranchDigest, memoryBranchDigest(recovered.branch));

  const retried = await recoveredStore.applyReviewAdmission({
    transactionId: TRANSACTION_ID,
    branchName: "main",
    expectedBranchDigest,
    operations: [{ action: "replace", entryId, content: "Reviewed durable fact.", importance: "high" }],
  });
  assert.deepEqual(retried, recovered);

  const revisionFiles = await readdir(join(store.projectDir, "revisions", "main"));
  assert.equal(revisionFiles.length, 1);
  const revision = await readFile(join(store.projectDir, "revisions", "main", revisionFiles[0]!), "utf8");
  assert.equal(JSON.parse(revision).id, recovered.revisionId);
});

test("foreground branch mutation finishes a branch-only admission before advancing memory", async (t) => {
  let crashed = false;
  const { base, store } = await fixture({
    admissionFailpoint: (phase) => {
      if (!crashed && phase === "branch-written") {
        crashed = true;
        throw new Error("simulated crash after branch");
      }
    },
  });
  t.after(() => rm(base, { recursive: true, force: true }));
  const original = await store.applyOperation("main", { action: "add", content: "Original." });
  const entryId = original.branch.entries.at(0)!.id;

  await assert.rejects(store.applyReviewAdmission({
    transactionId: `review_${"b".repeat(40)}`,
    branchName: "main",
    expectedBranchDigest: memoryBranchDigest(original.branch),
    operations: [{ action: "replace", entryId, content: "Reviewed.", importance: "normal" }],
  }), /simulated crash after branch/u);

  const foreground = await store.applyOperation("main", { action: "add", content: "Foreground addition." });
  assert.deepEqual(foreground.branch.entries.map((entry) => entry.text), ["Reviewed.", "Foreground addition."]);
  assert.equal((await readdir(join(store.projectDir, "revisions", "main"))).length, 1);
  const undone = await store.undoReview("main");
  assert.deepEqual(undone.branch.entries.map((entry) => entry.text), ["Original.", "Foreground addition."]);
});

test("recovery accepts an already-published exact revision and completes idempotently", async (t) => {
  let crashed = false;
  const { base, project, storage, store } = await fixture({
    admissionFailpoint: (phase) => {
      if (!crashed && phase === "revision-written") {
        crashed = true;
        throw new Error("simulated crash after revision");
      }
    },
  });
  t.after(() => rm(base, { recursive: true, force: true }));
  const original = await store.applyOperation("main", { action: "add", content: "Original." });
  const entryId = original.branch.entries.at(0)!.id;
  const transactionId = `review_${"c".repeat(40)}`;

  await assert.rejects(store.applyReviewAdmission({
    transactionId,
    branchName: "main",
    expectedBranchDigest: memoryBranchDigest(original.branch),
    operations: [{ action: "remove", entryId }],
  }), /simulated crash after revision/u);

  const recoveredStore = new ProjectMemoryStore(project, { storageRoot: storage });
  await recoveredStore.initialize();
  const result = await recoveredStore.getReviewAdmissionResult(transactionId);
  assert.equal(result?.status, "applied");
  assert.equal((await readdir(join(store.projectDir, "revisions", "main"))).length, 1);
});

test("stale admission and exact transaction retries return one frozen stable result", async (t) => {
  let now = new Date("2026-07-01T00:00:00.000Z");
  const { base, store } = await fixture({ now: () => now });
  t.after(() => rm(base, { recursive: true, force: true }));
  const baseBranch = await store.loadBranch("main");
  await store.applyOperation("main", { action: "add", content: "Concurrent foreground fact." });
  const transactionId = `review_${"d".repeat(40)}`;
  const request = {
    transactionId,
    branchName: "main",
    expectedBranchDigest: memoryBranchDigest(baseBranch),
    operations: [{ action: "add" as const, content: "Stale review fact.", importance: "high" as const }],
  };

  const stale = await store.applyReviewAdmission(request);
  assert.equal(stale.status, "stale");
  assert.match(stale.messages.at(0) ?? "", /Stale memory snapshot/u);
  now = new Date("2026-07-02T00:00:00.000Z");
  await store.applyOperation("main", { action: "add", content: "Still later foreground fact." });

  assert.deepEqual(await store.applyReviewAdmission(request), stale);
  assert.deepEqual(await store.getReviewAdmissionResult(transactionId), stale);
  await assert.rejects(store.applyReviewAdmission({
    ...request,
    operations: [{ action: "add", content: "Different retry.", importance: "high" }],
  }), /Conflicting memory review admission transaction/u);
  assert.deepEqual((await store.loadBranch("main")).entries.map((entry) => entry.text), [
    "Concurrent foreground fact.",
    "Still later foreground fact.",
  ]);
});

test("pending admission fails closed when canonical branch is neither base nor frozen result", async (t) => {
  let crashed = false;
  const { base, store } = await fixture({
    admissionFailpoint: (phase) => {
      if (!crashed && phase === "intent-written") {
        crashed = true;
        throw new Error("simulated crash after intent");
      }
    },
  });
  t.after(() => rm(base, { recursive: true, force: true }));
  const original = await store.applyOperation("main", { action: "add", content: "Base fact." });
  const entryId = original.branch.entries.at(0)!.id;
  const transactionId = `review_${"e".repeat(40)}`;

  await assert.rejects(store.applyReviewAdmission({
    transactionId,
    branchName: "main",
    expectedBranchDigest: memoryBranchDigest(original.branch),
    operations: [{ action: "replace", entryId, content: "Frozen result.", importance: "high" }],
  }), /simulated crash/u);

  const branchPath = join(store.projectDir, "branches", "main.json");
  const conflicting = JSON.parse(await readFile(branchPath, "utf8"));
  conflicting.entries.push({
    id: "manual-conflict",
    text: "Unexpected third state.",
    createdAt: conflicting.updatedAt,
    updatedAt: conflicting.updatedAt,
    importance: "normal",
  });
  await writeFile(branchPath, `${JSON.stringify(conflicting, null, 2)}\n`, "utf8");

  await assert.rejects(store.getReviewAdmissionResult(transactionId), /neither its base nor result/u);
  await assert.rejects(
    store.applyOperation("main", { action: "add", content: "Must not pass pending intent." }),
    /neither its base nor result/u,
  );
  await assert.rejects(store.loadBranch("main"), /neither its base nor result/u);
  const persisted = JSON.parse(await readFile(branchPath, "utf8"));
  assert.deepEqual(persisted.entries.map((entry: { text: string }) => entry.text), [
    "Base fact.",
    "Unexpected third state.",
  ]);
});

test("admission recovery scan fails closed at its configured bound", async (t) => {
  const { base, project, storage, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const admissionsDir = join(store.projectDir, "review-admissions");
  await Promise.all(["one", "two", "three"].map((id) =>
    writeFile(join(admissionsDir, `${id}.intent.json`), "{}\n", "utf8")));

  const bounded = new ProjectMemoryStore(project, { storageRoot: storage, admissionScanLimit: 2 });
  await assert.rejects(bounded.loadBranch("main"), /scan exceeds 2 full intents/u);
});
