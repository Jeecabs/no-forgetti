import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalPath, resolveProjectRoot } from "../src/project.ts";
import { ProjectMemoryStore } from "../src/store.ts";
import type { ReviewOperation } from "../src/types.ts";

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
  assert.equal(store.maxChars, 4_000);
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

test("review batches cannot cross the working target from below", async (t) => {
  const { base, store } = await fixture({ maxChars: 100 });
  t.after(() => rm(base, { recursive: true, force: true }));
  await store.applyOperation("main", { action: "add", content: "a".repeat(20) });

  const results = await store.applyOperations("main", [{
    action: "add",
    content: "b".repeat(60),
    importance: "normal",
  }]);

  assert.match(results.at(0)?.message ?? "", /working target of 75 characters/u);
  assert.deepEqual((await store.loadBranch("main")).entries.map((entry) => entry.text), ["a".repeat(20)]);
});

test("review batches above the working target must make net progress", async (t) => {
  const { base, store } = await fixture({ maxChars: 100 });
  t.after(() => rm(base, { recursive: true, force: true }));
  const added = await store.applyOperation("main", { action: "add", content: "a".repeat(80) });
  const entryId = added.branch.entries.at(0)!.id;

  const rejected = await store.applyOperations("main", [{ action: "assess", entryId, importance: "high" }]);
  const rejection = rejected.at(0);
  assert.ok(rejection);
  assert.match(rejection.message, /must shrink memory/u);

  const accepted = await store.applyOperations("main", [{
    action: "replace",
    entryId,
    content: "a".repeat(79),
    importance: "high",
  }]);
  const acceptedResult = accepted.at(0);
  assert.ok(acceptedResult);
  assert.equal(acceptedResult.changed, true);
  const refinedEntry = (await store.loadBranch("main")).entries.at(0);
  assert.ok(refinedEntry);
  assert.equal(refinedEntry.text.length, 79);
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
  assert.equal(await store.claimReviewIfDue("main", 3, 99), true);
  assert.equal(await store.claimReviewIfDue("main", 3, 99), false);
  await store.finishReview("main", false);
  assert.equal(await store.claimReviewIfDue("main", 3, 99), false);
  now = new Date(now.getTime() + 5 * 60_000 + 1);
  assert.equal(await store.claimReviewIfDue("main", 3, 99), true);
  await store.finishReview("main", true);
  assert.equal(await store.claimReviewIfDue("main", 3, 99), false);

  await store.forkBranch("main", "experiment");
  await store.recordUserTurn("experiment", 4);
  assert.equal(await store.claimReviewIfDue("experiment", 10, 4), true);
  assert.equal(await store.claimReviewIfDue("main", 10, 4), false);
  await store.finishReview("experiment", true);
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
