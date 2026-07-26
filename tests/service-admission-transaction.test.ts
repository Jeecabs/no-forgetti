import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AdmissionTransactionStore,
  admissionJsonDigest,
  createOrCompareJsonFile,
  type AdmissionIntent,
  type AdmissionPreparedArtifacts,
  type AdmissionRecoveryCallbacks,
  type JsonObject,
} from "../src/service/admission-transaction.ts";
import { createReviewJob, createReviewOutcome, type ReviewModelProvenance } from "../src/service/protocol.ts";
import type { MemoryBranch } from "../src/types.ts";

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
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-admission-wal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const branch: MemoryBranch = {
    version: 1,
    name: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    entries: [],
  };
  const job = createReviewJob({
    projectKey: "a".repeat(16),
    sessionId: "private-session",
    throughEntryId: "entry-1",
    transcript: "USER: remember the canonical check",
    branch,
    maxChars: 16_000,
  });
  const outcome = createReviewOutcome(job, {
    status: "completed",
    operations: [{ action: "add", content: "Canonical verification uses pnpm check.", importance: "high" }],
    provenance,
    completedAt: provenance.completedAt,
  });
  const afterBranch: JsonObject = {
    ...branch,
    updatedAt: provenance.completedAt,
    entries: [{
      id: "remembered",
      text: "Canonical verification uses pnpm check.",
      createdAt: provenance.completedAt,
      updatedAt: provenance.completedAt,
      createdBy: "background_review",
      updatedBy: "background_review",
      importance: "high",
      importanceAssessedAt: provenance.completedAt,
    }],
  };
  const resultingBranchDigest = admissionJsonDigest(afterBranch);
  const prepared: AdmissionPreparedArtifacts = {
    baseBranchDigest: job.baseBranchDigest,
    resultingBranchDigest,
    afterBranch,
    revision: {
      version: 1,
      kind: "review",
      branchName: "main",
      beforeDigest: job.baseBranchDigest,
      afterDigest: resultingBranchDigest,
      id: "revision-1",
    },
    receipt: {
      version: 1,
      proposalId: job.id,
      jobDigest: job.digest,
      projectKey: job.projectKey,
      branchName: job.branch.name,
      baseBranchDigest: job.baseBranchDigest,
      resultingBranchDigest,
      status: "applied",
    },
  };
  return { root, job, outcome, prepared };
}

function fakeRecovery(initial?: Partial<Record<"branch" | "revision" | "receipt", JsonObject>>) {
  const artifacts: Partial<Record<"branch" | "revision" | "receipt", JsonObject>> = { ...initial };
  const applied: string[] = [];
  const callbacks: AdmissionRecoveryCallbacks = Object.fromEntries(
    (["branch", "revision", "receipt"] as const).map((name) => [name, {
      inspect: async (intent: AdmissionIntent) => {
        const expected = name === "branch" ? intent.afterBranch : intent[name];
        const actual = artifacts[name];
        if (actual === undefined) return "missing" as const;
        return admissionJsonDigest(actual) === admissionJsonDigest(expected!) ? "matching" as const : "conflicting" as const;
      },
      apply: async (intent: AdmissionIntent) => {
        applied.push(name);
        artifacts[name] = structuredClone((name === "branch" ? intent.afterBranch : intent[name])!);
      },
    }]),
  ) as unknown as AdmissionRecoveryCallbacks;
  return { artifacts, applied, callbacks };
}

test("admission intent freezes the complete proposal and rolls forward exactly once", async (t) => {
  const { root, job, outcome, prepared } = await fixture(t);
  const transactions = new AdmissionTransactionStore(root);
  let prepares = 0;
  const intent = await transactions.begin(job, outcome, async () => {
    prepares += 1;
    return prepared;
  });

  assert.equal(Object.isFrozen(intent), true);
  assert.equal(Object.isFrozen(intent.outcome), true);
  assert.equal(intent.job.digest, job.digest);
  assert.deepEqual(intent.outcome, outcome);
  assert.equal(intent.baseBranchDigest, job.baseBranchDigest);
  assert.equal(intent.resultingBranchDigest, admissionJsonDigest(intent.afterBranch));
  assert.equal(intent.proposalDigest, admissionJsonDigest(outcome as unknown as JsonObject));

  const intentPath = join(root, job.id, "intent.json");
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, job.id))).mode & 0o777, 0o700);
  assert.equal((await stat(intentPath)).mode & 0o777, 0o600);

  const recovery = fakeRecovery();
  const completed = await transactions.recover(intent, recovery.callbacks);
  assert.equal(completed.phase, "complete");
  assert.deepEqual(recovery.applied, ["branch", "revision", "receipt"]);

  const replay = await transactions.begin(job, outcome, async () => {
    prepares += 1;
    throw new Error("must not prepare an existing intent");
  });
  assert.deepEqual(replay, intent);
  assert.equal(prepares, 1);
  await transactions.recover(replay, recovery.callbacks);
  assert.deepEqual(recovery.applied, ["branch", "revision", "receipt"]);
});

test("recovery resumes after crashes following every durable publication", async (t) => {
  const { root, job, outcome, prepared } = await fixture(t);
  const transactions = new AdmissionTransactionStore(root);
  const intent = await transactions.begin(job, outcome, async () => prepared); // crash after intent
  const recovery = fakeRecovery();
  assert.equal((await transactions.inspect(intent, recovery.callbacks)).phase, "branch");

  for (const phase of ["branch", "revision", "receipt"] as const) {
    const original = recovery.callbacks[phase]!.apply;
    recovery.callbacks[phase]!.apply = async (current) => {
      await original(current);
      throw new Error(`crash after ${phase}`);
    };
    await assert.rejects(transactions.recover(intent, recovery.callbacks), new RegExp(`crash after ${phase}`));
    recovery.callbacks[phase]!.apply = original;
    const expectedNext = phase === "branch" ? "revision" : phase === "revision" ? "receipt" : "complete";
    assert.equal((await transactions.inspect(intent, recovery.callbacks)).phase, expectedNext);
  }

  assert.equal((await transactions.recover(intent, recovery.callbacks)).phase, "complete");
  assert.deepEqual(recovery.applied, ["branch", "revision", "receipt"]);
});

test("no-op intent recovery skips the absent revision without false out-of-order failure", async (t) => {
  const { root, job } = await fixture(t);
  const outcome = createReviewOutcome(job, {
    status: "completed",
    operations: [],
    provenance,
    completedAt: provenance.completedAt,
  });
  const prepared: AdmissionPreparedArtifacts = {
    baseBranchDigest: job.baseBranchDigest,
    resultingBranchDigest: admissionJsonDigest(job.branch as unknown as JsonObject),
    afterBranch: job.branch,
    revision: null,
    receipt: {
      version: 1,
      proposalId: job.id,
      jobDigest: job.digest,
      projectKey: job.projectKey,
      branchName: job.branch.name,
      baseBranchDigest: job.baseBranchDigest,
      resultingBranchDigest: admissionJsonDigest(job.branch as unknown as JsonObject),
      status: "noop",
    },
  };
  const transactions = new AdmissionTransactionStore(root);
  const intent = await transactions.begin(job, outcome, async () => prepared);
  const recovery = fakeRecovery();

  assert.equal((await transactions.inspect(intent, recovery.callbacks)).phase, "branch");
  assert.equal((await transactions.recover(intent, recovery.callbacks)).phase, "complete");
  assert.deepEqual(recovery.applied, ["branch", "receipt"]);
});

test("intent and recovery mismatches fail closed", async (t) => {
  const { root, job, outcome, prepared } = await fixture(t);
  const transactions = new AdmissionTransactionStore(root);
  const intent = await transactions.begin(job, outcome, async () => prepared);
  const conflictingOutcome = createReviewOutcome(job, {
    status: "completed",
    operations: [],
    provenance,
    completedAt: provenance.completedAt,
  });
  await assert.rejects(
    transactions.begin(job, conflictingOutcome, async () => prepared),
    /conflicting admission intent/i,
  );

  const recovery = fakeRecovery({ branch: { wrong: true } });
  await assert.rejects(transactions.recover(intent, recovery.callbacks), /conflicting branch publication/i);
  assert.deepEqual(recovery.applied, []);

  const outOfOrder = fakeRecovery({ revision: intent.revision! });
  await assert.rejects(transactions.inspect(intent, outOfOrder.callbacks), /out of order/i);

  const intentPath = join(root, job.id, "intent.json");
  const tampered = JSON.parse(await readFile(intentPath, "utf8")) as Record<string, unknown>;
  tampered.unexpected = true;
  await writeFile(intentPath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
  await assert.rejects(transactions.load(job.id), /object shape/i);
});

test("create-or-compare JSON publication is atomic, bounded, and private", async (t) => {
  const { root } = await fixture(t);
  const path = join(root, "artifacts", "receipt.json");
  assert.equal(await createOrCompareJsonFile(path, { version: 1, ok: true }, 128), "created");
  assert.equal(await createOrCompareJsonFile(path, { ok: true, version: 1 }, 128), "matching");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(createOrCompareJsonFile(path, { version: 1, ok: false }, 128), /conflicting publication/i);
  await assert.rejects(createOrCompareJsonFile(join(root, "large.json"), { value: "x".repeat(200) }, 128), /exceeds 128 bytes/i);

  await chmod(path, 0o644);
  await assert.rejects(createOrCompareJsonFile(path, { version: 1, ok: true }, 128), /private 0600 file/i);
});
