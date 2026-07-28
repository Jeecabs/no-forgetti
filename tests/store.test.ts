import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { memoryCharCount } from "../src/context.ts";
import { canonicalPath, resolveProjectRoot } from "../src/project.ts";
import { memoryBranchDigest, memoryEntryDigest, ProjectMemoryStore } from "../src/store.ts";
import { STORE_FILE_BYTE_LIMIT, type ReviewOperation } from "../src/types.ts";

async function fixture(options: { maxChars?: number; now?: () => Date } = {}) {
  const base = await mkdtemp(join(tmpdir(), "pi-project-memory-"));
  const project = join(base, "repo");
  const storage = join(base, "state");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, ".git"), "gitdir: elsewhere\n", "utf8");
  const store = new ProjectMemoryStore(project, { storageRoot: storage, maxChars: options.maxChars, now: options.now });
  await store.initialize();
  return { base, project, storage, store };
}

test("resolves git root and falls back to exact cwd", async (t) => {
  const { base, project } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  assert.equal(resolveProjectRoot(join(project, "src")), canonicalPath(project));

  const plain = join(base, "plain", "nested");
  await mkdir(plain, { recursive: true });
  assert.equal(resolveProjectRoot(plain), canonicalPath(plain));
});

test("adds, deduplicates, replaces, and removes entries", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));

  const added = await store.applyOperation("main", { action: "add", content: "Tests run with pnpm test." }, "session-1");
  assert.equal(added.changed, true);
  assert.equal(added.branch.entries[0]?.sourceSessionId, "session-1");
  assert.equal(added.branch.entries[0]?.createdBy, "assistant_tool");

  const duplicate = await store.applyOperation("main", { action: "add", content: "Tests run with pnpm test." });
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.branch.entries.length, 1);

  const replaced = await store.applyOperation("main", {
    action: "replace",
    oldText: "pnpm test",
    content: "Tests run with pnpm test; typecheck with pnpm check.",
  });
  assert.equal(replaced.branch.entries[0]?.text, "Tests run with pnpm test; typecheck with pnpm check.");

  const removed = await store.applyOperation("main", { action: "remove", oldText: "typecheck" });
  assert.equal(removed.branch.entries.length, 0);
});

test("rolls importance forward while leaving defaulted entries unassessed", async (t) => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const { base, store } = await fixture({ now: () => now });
  t.after(() => rm(base, { recursive: true, force: true }));

  await store.applyOperation("main", { action: "add", content: "Legacy project convention." });
  const defaulted = (await store.loadBranch("main")).entries.at(0);
  assert.ok(defaulted);
  assert.equal(defaulted.importance, "normal");
  assert.equal(defaulted.importanceAssessedAt, undefined);

  now = new Date("2026-01-02T00:00:00.000Z");
  await store.applyOperation("main", {
    action: "add",
    content: "Forgetting the deployment workflow causes costly rediscovery.",
    importance: "high",
  });
  const assessed = (await store.loadBranch("main")).entries.at(1);
  assert.ok(assessed);
  assert.equal(assessed.importance, "high");
  assert.equal(assessed.importanceAssessedAt, "2026-01-02T00:00:00.000Z");
});

test("background review assesses legacy importance without rewriting memory text", async (t) => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const { base, store } = await fixture({ now: () => now });
  t.after(() => rm(base, { recursive: true, force: true }));

  const added = await store.applyOperation("main", { action: "add", content: "Canonical deploy command is expensive to rediscover." });
  const entry = added.branch.entries.at(0)!;
  now = new Date("2026-01-02T00:00:00.000Z");
  const results = await store.applyOperations("main", [{ action: "assess", entryId: entry.id, importance: "high" }]);

  assert.equal(results.at(0)?.message, "Memory importance assessed.");
  const assessed = (await store.loadBranch("main")).entries.at(0)!;
  assert.equal(assessed.text, entry.text);
  assert.equal(assessed.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(assessed.importance, "high");
  assert.equal(assessed.importanceAssessedAt, "2026-01-02T00:00:00.000Z");
});

test("background review rejects unknown operations without mutating entries", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const added = await store.applyOperation("main", { action: "add", content: "Keep this fact unchanged." });
  const entryId = added.branch.entries.at(0)!.id;

  const results = await store.applyOperations("main", [{
    action: "noop",
    entryId,
    importance: "high",
  } as unknown as ReviewOperation]);

  const rejection = results.at(0);
  assert.ok(rejection);
  assert.match(rejection.message, /Invalid memory review operation action/u);
  const entry = (await store.loadBranch("main")).entries.at(0);
  assert.ok(entry);
  assert.equal(entry.importance, "normal");
  assert.equal(entry.importanceAssessedAt, undefined);
});

test("default capacity accepts memory beyond the old 2,200-character limit", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));

  await store.applyOperation("main", { action: "add", content: "a".repeat(800) });
  await store.applyOperation("main", { action: "add", content: "b".repeat(800) });
  await store.applyOperation("main", { action: "add", content: "c".repeat(800) });
  assert.equal(store.maxChars, 6_000);
  assert.equal((await store.loadBranch("main")).entries.length, 3);
});

test("requires unique substring and enforces capacity", async (t) => {
  const { base, store } = await fixture({ maxChars: 45 });
  t.after(() => rm(base, { recursive: true, force: true }));

  await store.applyOperation("main", { action: "add", content: "Uses TypeScript strict mode." });
  await assert.rejects(
    store.applyOperation("main", { action: "add", content: "Verification command is pnpm test." }),
    /exceed 45 characters/u,
  );

  const roomy = new ProjectMemoryStore(store.projectRoot, { storageRoot: join(base, "roomy") });
  await roomy.initialize();
  await roomy.applyOperation("main", { action: "add", content: "Install commands use pnpm." });
  await roomy.applyOperation("main", { action: "add", content: "Test commands use pnpm." });
  await assert.rejects(
    roomy.applyOperation("main", { action: "remove", oldText: "use pnpm" }),
    /matches 2 entries/u,
  );
});

test("review batch consolidates atomically against final capacity", async (t) => {
  const { base, store } = await fixture({ maxChars: 45 });
  t.after(() => rm(base, { recursive: true, force: true }));
  const added = await store.applyOperation("main", { action: "add", content: "Project commands use pnpm." });
  const originalId = added.branch.entries.at(0)!.id;

  const results = await store.applyOperations("main", [
    { action: "add", content: "Verification uses pnpm check.", importance: "high" },
    { action: "remove", entryId: originalId },
  ]);
  assert.equal(results.length, 2);
  assert.equal(results.every((result) => result.changed), true);
  const consolidated = await store.loadBranch("main");
  assert.deepEqual(consolidated.entries.map((entry) => entry.text), ["Verification uses pnpm check."]);
  const consolidatedEntry = consolidated.entries.at(0);
  assert.ok(consolidatedEntry);
  assert.equal(consolidatedEntry.createdBy, "background_review");
  assert.equal(consolidatedEntry.importance, "high");
  assert.ok(consolidatedEntry.importanceAssessedAt);

  await store.undoReview("main");
  assert.deepEqual((await store.loadBranch("main")).entries.map((entry) => entry.text), ["Project commands use pnpm."]);
  await assert.rejects(store.undoReview("main"), /No automatic memory review/u);

  const rejected = await store.applyOperations("main", [
    { action: "add", content: "TypeScript compilation uses strict mode.", importance: "normal" },
    { action: "remove", entryId: "missing-entry" },
  ]);
  const rejection = rejected.at(0);
  assert.ok(rejection);
  assert.match(rejection.message, /memory unchanged/u);
  assert.deepEqual((await store.loadBranch("main")).entries.map((entry) => entry.text), ["Project commands use pnpm."]);
});

test("computes exact stable SHA-256 digests for branches and entries", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  await store.applyOperation("main", { action: "add", content: "First exact fact.", importance: "high" }, "session-1");
  await store.applyOperation("main", { action: "add", content: "Second exact fact." });
  const branch = await store.loadBranch("main");
  const entry = branch.entries.at(0)!;

  assert.match(memoryEntryDigest(entry), /^[a-f0-9]{64}$/u);
  assert.equal(store.entryDigest({ ...entry }), memoryEntryDigest(entry));
  assert.equal(store.branchDigest({ ...branch, entries: branch.entries.map((item) => ({ ...item })) }), memoryBranchDigest(branch));
  assert.notEqual(memoryEntryDigest({ ...entry, sourceSessionId: "session-2" }), memoryEntryDigest(entry));
  assert.notEqual(memoryEntryDigest({ ...entry, importance: "normal" }), memoryEntryDigest(entry));
  assert.notEqual(memoryBranchDigest({ ...branch, updatedAt: new Date(0).toISOString() }), memoryBranchDigest(branch));
  assert.notEqual(memoryBranchDigest({ ...branch, entries: [...branch.entries].reverse() }), memoryBranchDigest(branch));
});

test("CAS review apply rejects a stale exact branch digest", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const added = await store.applyOperation("main", { action: "add", content: "Stable fact." });
  const entryId = added.branch.entries.at(0)!.id;
  const expectedDigest = memoryBranchDigest(added.branch);
  await store.applyOperation("main", { action: "add", content: "Later foreground fact." });

  const stale = await store.applyOperations(
    "main",
    [{ action: "assess", entryId, importance: "high" }],
    undefined,
    "background_review",
    expectedDigest,
  );
  assert.equal(stale.length, 1);
  assert.equal(stale.at(0)?.changed, false);
  assert.match(stale.at(0)?.message ?? "", /Stale memory snapshot/u);
  assert.equal((await store.loadBranch("main")).entries.at(0)?.importance, "normal");

  const current = await store.loadBranch("main");
  const applied = await store.applyOperations(
    "main",
    [{ action: "assess", entryId, importance: "high" }],
    undefined,
    "background_review",
    memoryBranchDigest(current),
  );
  assert.equal(applied.at(0)?.changed, true);
});

test("keeps an append-only multi-revision review and undo journal", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const first = await store.applyOperation("main", { action: "add", content: "First original." });
  const second = await store.applyOperation("main", { action: "add", content: "Second original." });
  const firstId = first.branch.entries.at(0)!.id;
  const secondId = second.branch.entries.at(1)!.id;

  await store.applyOperations("main", [{
    action: "replace",
    entryId: firstId,
    content: "First reviewed.",
    importance: "high",
  }]);
  await store.applyOperations("main", [{
    action: "replace",
    entryId: secondId,
    content: "Second reviewed.",
    importance: "normal",
  }]);

  const journalDir = join(store.projectDir, "revisions", "main");
  assert.equal((await readdir(journalDir)).length, 2);
  assert.deepEqual((await store.undoReview("main")).branch.entries.map((entry) => entry.text), [
    "First reviewed.",
    "Second original.",
  ]);
  assert.equal((await readdir(journalDir)).length, 3, "undo appends rather than deleting review commit");
  assert.deepEqual((await store.undoReview("main")).branch.entries.map((entry) => entry.text), [
    "First original.",
    "Second original.",
  ]);
  await assert.rejects(store.undoReview("main"), /No automatic memory review/u);

  const files = (await readdir(journalDir)).sort();
  assert.equal(files.length, 4);
  const kinds = await Promise.all(files.map(async (file) => {
    const record = JSON.parse(await readFile(join(journalDir, file), "utf8")) as { kind?: unknown };
    return record.kind;
  }));
  assert.deepEqual(kinds, ["review", "review", "undo", "undo"]);
});

test("inverse-CAS undo preserves later foreground writes and rejects overwritten review entries", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const added = await store.applyOperation("main", { action: "add", content: "Original durable fact." });
  const entryId = added.branch.entries.at(0)!.id;
  await store.applyOperations("main", [{
    action: "replace",
    entryId,
    content: "Reviewed durable fact.",
    importance: "high",
  }]);
  await store.applyOperation("main", { action: "add", content: "Later foreground addition." });

  const undone = await store.undoReview("main");
  assert.deepEqual(undone.branch.entries.map((entry) => entry.text), [
    "Original durable fact.",
    "Later foreground addition.",
  ]);

  await store.applyOperations("main", [{
    action: "replace",
    entryId,
    content: "Second reviewed fact.",
    importance: "normal",
  }]);
  await store.applyOperation("main", {
    action: "replace",
    oldText: "Second reviewed",
    content: "Later foreground correction.",
  });
  await assert.rejects(store.undoReview("main"), /changed after the review/u);
  assert.deepEqual((await store.loadBranch("main")).entries.map((entry) => entry.text), [
    "Later foreground correction.",
    "Later foreground addition.",
  ]);
});

test("reserves hard-limit headroom from background review growth", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const content of ["a", "b", "c", "d", "e"]) {
    await store.applyOperation("main", { action: "add", content: content.repeat(800) });
  }

  const reachingTarget = await store.applyOperations("main", [{
    action: "add",
    content: "f".repeat(500),
    importance: "normal",
  }]);
  assert.equal(reachingTarget.at(0)?.changed, true);
  assert.equal(memoryCharCount(await store.loadBranch("main")), 4_500);

  const entryId = (await store.loadBranch("main")).entries.at(0)!.id;
  const assessment = await store.applyOperations("main", [{ action: "assess", entryId, importance: "high" }]);
  assert.equal(assessment.at(0)?.changed, true, "metadata-only review may keep usage equal to target");

  const growth = await store.applyOperations("main", [{
    action: "add",
    content: "e",
    importance: "normal",
  }]);
  assert.match(growth.at(0)?.message ?? "", /Review batch skipped.*cannot grow at or above the 4500-character working target/u);
  assert.equal(memoryCharCount(await store.loadBranch("main")), 4_500);

  const refinement = await store.applyOperations("main", [{
    action: "replace",
    entryId,
    content: "a".repeat(799),
    importance: "high",
  }]);
  assert.equal(refinement.at(0)?.changed, true);
  assert.equal(memoryCharCount(await store.loadBranch("main")), 4_499);
});

test("accepts the former 4,023-character overflow scenario below the new target", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const content of ["a", "b", "c"]) {
    await store.applyOperation("main", { action: "add", content: content.repeat(800) });
  }
  await store.applyOperation("main", { action: "add", content: "d".repeat(745) });

  const applied = await store.applyOperations("main", [
    { action: "add", content: "e".repeat(800), importance: "normal" },
    { action: "add", content: "f".repeat(78), importance: "normal" },
  ]);

  assert.equal(applied.every((result) => result.changed), true);
  assert.equal(memoryCharCount(await store.loadBranch("main")), 4_023);
});

test("review batches below the working target cannot consume reserved headroom", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const content of ["a", "b", "c", "d", "e"]) {
    await store.applyOperation("main", { action: "add", content: content.repeat(800) });
  }

  const skipped = await store.applyOperations("main", [{
    action: "add",
    content: "f".repeat(501),
    importance: "normal",
  }]);
  assert.match(skipped.at(0)?.message ?? "", /Review batch skipped.*exceed the working target of 4500 characters \(4501\/4500\)/u);
  assert.equal(memoryCharCount(await store.loadBranch("main")), 4_000);
});

test("does not allow configuration to raise the 6,000-character hard cap", async (t) => {
  const { base, store } = await fixture({ maxChars: 10_000 });
  t.after(() => rm(base, { recursive: true, force: true }));
  assert.equal(store.maxChars, 6_000);
  for (const content of ["a", "b", "c", "d", "e", "f", "g"]) {
    await store.applyOperation("main", { action: "add", content: content.repeat(800) });
  }
  await store.applyOperation("main", { action: "add", content: "h".repeat(400) });
  await assert.rejects(
    store.applyOperation("main", { action: "add", content: "i" }),
    /exceed 6000 characters/u,
  );
});

test("background review merges explicitly targeted entries", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const general = "For TypeScript verification, do not run legacy tsc; use tsgo only when needed.";
  const specific = "Use tsgo instead of tsc; root tsconfig needs compatibility changes.";
  const first = await store.applyOperation("main", { action: "add", content: general });
  const second = await store.applyOperation("main", { action: "add", content: specific });
  const firstId = first.branch.entries.at(0)!.id;
  const secondId = second.branch.entries.at(1)!.id;

  const results = await store.applyOperations("main", [{
    action: "merge",
    entryIds: [firstId, secondId],
    content: "Use tsgo instead of legacy tsc; root tsconfig may need compatibility changes.",
    importance: "high",
  }]);

  const result = results.at(0);
  assert.ok(result);
  assert.equal(result.message, "Memory entries merged.");
  const merged = (await store.loadBranch("main")).entries;
  assert.deepEqual(merged.map((entry) => entry.text), [
    "Use tsgo instead of legacy tsc; root tsconfig may need compatibility changes.",
  ]);
  const mergedEntry = merged.at(0);
  assert.ok(mergedEntry);
  assert.equal(mergedEntry.id, firstId);
  assert.equal(mergedEntry.importance, "high");
  assert.ok(mergedEntry.importanceAssessedAt);
});

test("background memory reviews apply immediately with provenance metadata", async (t) => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const { base, store } = await fixture({ now: () => now });
  t.after(() => rm(base, { recursive: true, force: true }));

  const results = await store.applyOperations(
    "main",
    [{ action: "add", content: "Tests run with pnpm test.", importance: "normal" }],
    "session-1",
    "background_review",
  );
  assert.equal(results.some((result) => result.changed), true);
  const entry = (await store.loadBranch("main")).entries.at(0);
  assert.ok(entry);
  assert.equal(entry.sourceSessionId, "session-1");
  assert.equal(entry.createdBy, "background_review");
  assert.equal(entry.updatedBy, "background_review");
  assert.equal(entry.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(entry.updatedAt, "2026-01-01T00:00:00.000Z");

  now = new Date("2026-01-02T00:00:00.000Z");
  await store.applyOperations("main", [{
    action: "replace",
    entryId: entry.id,
    content: "Tests and type checks run with pnpm check.",
    importance: "high",
  }], "session-2", "background_review");
  const refined = (await store.loadBranch("main")).entries.at(0);
  assert.ok(refined);
  assert.equal(refined.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(refined.updatedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(refined.createdBy, "background_review");
  assert.equal(refined.updatedBy, "background_review");
  assert.equal(refined.importance, "high");
  assert.equal(refined.importanceAssessedAt, "2026-01-02T00:00:00.000Z");
});

test("initialization discards obsolete pending memory proposals", async (t) => {
  const { base, project, storage, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const pendingDir = join(store.projectDir, "memory-pending");
  await mkdir(pendingDir);
  await writeFile(join(pendingDir, "20260722015516-08854b1c.json"), "{}\n");

  await new ProjectMemoryStore(project, { storageRoot: storage }).initialize();
  await assert.rejects(stat(pendingDir), { code: "ENOENT" });
});

test("explicit memory fork copies then diverges", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));

  await store.applyOperation("main", { action: "add", content: "Main convention." });
  const fork = await store.forkBranch("main", "experiment");
  assert.equal(fork.parent, "main");
  assert.deepEqual(fork.entries.map((entry) => entry.text), ["Main convention."]);

  await store.applyOperation("experiment", { action: "add", content: "Experiment-only convention." });
  assert.equal((await store.loadBranch("main")).entries.length, 1);
  assert.equal((await store.loadBranch("experiment")).entries.length, 2);
});

test("review cadence uses signals, backoff, and branch-local state", async (t) => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const { base, store } = await fixture({ now: () => now });
  t.after(() => rm(base, { recursive: true, force: true }));

  for (let i = 0; i < 3; i++) await store.recordUserTurn("main");
  const failed = await store.claimReview("main", 3, 99);
  assert.ok(failed);
  assert.equal(await store.claimReview("main", 3, 99), undefined);
  await store.finishReviewClaim("main", failed, false);
  assert.equal(await store.claimReview("main", 3, 99), undefined);
  now = new Date(now.getTime() + 5 * 60_000 + 1);
  const retried = await store.claimReview("main", 3, 99);
  assert.ok(retried);
  await store.finishReviewClaim("main", retried, true);
  assert.equal(await store.claimReview("main", 3, 99), undefined);

  await store.forkBranch("main", "experiment");
  await store.recordUserTurn("experiment", 4);
  const forked = await store.claimReview("experiment", 10, 4);
  assert.ok(forked);
  assert.equal(await store.claimReview("main", 10, 4), undefined);
  await store.finishReviewClaim("experiment", forked, true);
});

test("fenced review success preserves activity recorded after its snapshot", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));

  for (let i = 0; i < 3; i++) await store.recordUserTurn("main", 1);
  const claim = await store.claimReview("main", 3, 99);
  assert.ok(claim);
  assert.equal(claim.branchName, "main");
  assert.equal(claim.capturedTurns, 3);
  assert.equal(claim.capturedSignalScore, 3);

  await store.recordUserTurn("main", 2);
  assert.equal(await store.finishReviewClaim("main", claim, true), true);
  assert.ok(await store.claimReview("main", 99, 2), "post-snapshot signal remains due");
});

test("only the current review generation can settle cadence once", async (t) => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const { base, store } = await fixture({ now: () => now });
  t.after(() => rm(base, { recursive: true, force: true }));

  await store.recordUserTurn("main", 4);
  const stale = await store.claimReview("main", 1, 99);
  assert.ok(stale);

  now = new Date(now.getTime() + 5 * 60_000 + 1);
  const current = await store.claimReview("main", 1, 99);
  assert.ok(current);
  assert.equal(current.generation, stale.generation + 1);
  assert.notEqual(current.token, stale.token);

  assert.equal(await store.finishReviewClaim("main", stale, true), false);
  await store.recordUserTurn("main", 2);
  assert.equal(await store.finishReviewClaim("main", current, true), true);
  assert.equal(await store.finishReviewClaim("main", current, true), false);
  assert.ok(await store.claimReview("main", 99, 2), "current claim subtracts only its snapshot");
});

test("a serialized claim settles cadence from another store instance", async (t) => {
  const { base, project, storage, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));

  await store.recordUserTurn("main");
  const claim = await store.claimReview("main", 1, 99);
  assert.ok(claim);
  const queuedClaim = JSON.parse(JSON.stringify(claim)) as typeof claim;
  const workerStore = new ProjectMemoryStore(project, { storageRoot: storage });
  await workerStore.initialize();

  assert.equal(await workerStore.finishReviewClaim("main", queuedClaim, true), true);
  assert.equal(await store.finishReviewClaim("main", claim, true), false);
  assert.equal(await store.claimReview("main", 1, 99), undefined);
});

test("rejects over-limit state bytes before JSON parsing", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const path = join(store.projectDir, "branches", "main.json");
  await writeFile(path, Buffer.alloc(STORE_FILE_BYTE_LIMIT + 1, 0x20));

  await assert.rejects(
    store.loadBranch("main"),
    new RegExp(`exceeds ${STORE_FILE_BYTE_LIMIT} byte limit before parsing`, "u"),
  );
});

test("rejects oversized and future-version on-disk branches", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const path = join(store.projectDir, "branches", "main.json");
  const original = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

  await writeFile(path, JSON.stringify({ ...original, entries: [{ id: "x", text: "x".repeat(801) }] }), "utf8");
  await assert.rejects(store.loadBranch("main"), /oversized entry/u);

  await writeFile(path, JSON.stringify({ ...original, version: 999 }), "utf8");
  await assert.rejects(store.loadBranch("main"), /Unsupported memory branch version/u);
});

test("rejects invalid importance metadata and duplicate entry IDs on disk", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const path = join(store.projectDir, "branches", "main.json");
  const original = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

  await writeFile(path, JSON.stringify({ ...original, entries: [{ id: "x", text: "fact", importance: "urgent" }] }), "utf8");
  await assert.rejects(store.loadBranch("main"), /Invalid memory importance/u);

  await writeFile(path, JSON.stringify({
    ...original,
    entries: [
      { id: "same", text: "first", importance: "normal" },
      { id: "same", text: "second", importance: "normal" },
    ],
  }), "utf8");
  await assert.rejects(store.loadBranch("main"), /duplicate entry IDs/u);
});

test("rejects malformed review state instead of resetting cadence", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  await writeFile(join(store.projectDir, "reviews", "main.json"), "null\n");
  await assert.rejects(store.recordUserTurn("main"), /Invalid memory review state/u);
});

test("refuses corrupt branch rather than overwriting it", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));

  const path = join(store.projectDir, "branches", "main.json");
  await writeFile(path, "{not-json", "utf8");
  await assert.rejects(store.loadBranch("main"));
  await assert.rejects(store.initialize());
  assert.equal(await readFile(path, "utf8"), "{not-json");
});
