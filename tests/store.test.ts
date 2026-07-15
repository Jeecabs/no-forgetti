import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalPath, resolveProjectRoot } from "../src/project.ts";
import { ProjectMemoryStore } from "../src/store.ts";

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
  await store.applyOperation("main", { action: "add", content: "Project commands use pnpm." });

  const results = await store.applyOperations("main", [
    { action: "add", content: "Verification uses pnpm check." },
    { action: "remove", oldText: "commands use pnpm" },
  ]);
  assert.equal(results.filter((result) => result.changed).length, 2);
  const consolidated = await store.loadBranch("main");
  assert.deepEqual(consolidated.entries.map((entry) => entry.text), ["Verification uses pnpm check."]);
  assert.equal(consolidated.entries[0]?.createdBy, "background_review");

  await store.undoReview("main");
  assert.deepEqual((await store.loadBranch("main")).entries.map((entry) => entry.text), ["Project commands use pnpm."]);
  await assert.rejects(store.undoReview("main"), /No automatic memory review/u);

  const rejected = await store.applyOperations("main", [
    { action: "add", content: "TypeScript compilation uses strict mode." },
    { action: "remove", oldText: "missing entry" },
  ]);
  assert.match(rejected[0]?.message ?? "", /memory unchanged/u);
  assert.deepEqual((await store.loadBranch("main")).entries.map((entry) => entry.text), ["Project commands use pnpm."]);
});

test("background memory reviews remain pending until explicit approval", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const proposal = await store.stageReviewProposal("main", [{ action: "add", content: "Tests run with pnpm test." }], "session-1");
  assert.ok(proposal);
  assert.equal((await store.loadBranch("main")).entries.length, 0);
  assert.equal((await store.listPendingReviews()).length, 1);
  const results = await store.approveReviewProposal(proposal.id);
  assert.equal(results.some((result) => result.changed), true);
  assert.equal((await store.loadBranch("main")).entries.length, 1);
  assert.equal((await store.listPendingReviews()).length, 0);

  const rejected = await store.stageReviewProposal("main", [{ action: "remove", oldText: "pnpm test" }], "session-2");
  assert.ok(rejected);
  await store.rejectReviewProposal(rejected.id);
  assert.equal((await store.loadBranch("main")).entries.length, 1);
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
