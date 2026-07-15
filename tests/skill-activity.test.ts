import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SkillActivityIndex } from "../src/skill-activity.ts";

async function fixture(options: ConstructorParameters<typeof SkillActivityIndex>[1] = {}) {
  const base = await mkdtemp(join(tmpdir(), "pi-skill-activity-"));
  const index = new SkillActivityIndex(base, options);
  await index.initialize();
  return { base, index };
}

function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

test("indexes session membership and generation usage without storing raw session ids", async (t) => {
  const now = new Date("2026-01-02T03:04:05.000Z");
  const { base, index } = await fixture({ now: () => now });
  t.after(() => rm(base, { recursive: true, force: true }));

  assert.deepEqual(await index.beginSession("session-alpha"), { isNew: true, completedCount: 0 });
  assert.deepEqual(await index.beginSession("session-alpha"), { isNew: false, completedCount: 0 });
  await index.beginSession("session-beta");

  await index.recordUse("session-alpha", "generation-a");
  await index.recordUse("session-alpha", "generation-a");
  await index.recordUse("session-alpha", "generation-b");
  await index.recordUse("session-beta", "generation-a");

  assert.deepEqual(await index.generationUsage("generation-a"), {
    version: 1,
    useCount: 3,
    useSessionCount: 2,
    lastUsedCompletedSession: 1,
    lastUsedAt: now.toISOString(),
  });
  assert.deepEqual(await index.generationUsage("generation-b"), {
    version: 1,
    useCount: 1,
    useSessionCount: 1,
    lastUsedCompletedSession: 1,
    lastUsedAt: now.toISOString(),
  });

  assert.deepEqual((await readdir(index.sessionsDir)).sort(), [
    `${sessionKey("session-alpha")}.json`,
    `${sessionKey("session-beta")}.json`,
  ].sort());
  assert.deepEqual((await readdir(index.generationsDir)).sort(), ["generation-a.json", "generation-b.json"]);
  const storedSessions = await Promise.all((await readdir(index.sessionsDir)).map((name) => readFile(join(index.sessionsDir, name), "utf8")));
  assert.doesNotMatch(storedSessions.join("\n"), /session-alpha|session-beta/u);
});

test("counts only newly completed sessions and assigns usage to completion order", async (t) => {
  const { base, index } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));

  await index.beginSession("session-late");
  await index.beginSession("session-early");
  await index.beginSession("still-open");
  await index.recordUse("session-late", "shared-generation");
  await index.recordUse("session-early", "shared-generation");

  assert.equal(await index.completedCount(), 0);
  assert.deepEqual(await index.completeSession("session-early"), {
    isNew: true,
    completedCount: 1,
    usedGenerationIds: ["shared-generation"],
  });
  assert.equal((await index.generationUsage("shared-generation")).lastUsedCompletedSession, 1);
  assert.deepEqual(await index.completeSession("session-early"), {
    isNew: false,
    completedCount: 1,
    usedGenerationIds: ["shared-generation"],
  });

  assert.deepEqual(await index.completeSession("session-late"), {
    isNew: true,
    completedCount: 2,
    usedGenerationIds: ["shared-generation"],
  });
  assert.equal(await index.completedCount(), 2);
  assert.equal((await index.generationUsage("shared-generation")).lastUsedCompletedSession, 2);

  await index.recordUse("session-early", "shared-generation");
  const resumedUsage = await index.generationUsage("shared-generation");
  assert.equal(resumedUsage.useCount, 3);
  assert.equal(resumedUsage.useSessionCount, 2);
  assert.equal(resumedUsage.lastUsedCompletedSession, 2);
  assert.equal(typeof resumedUsage.lastUsedAt, "string");
});

test("keeps growing activity in bounded per-session and per-generation records", async (t) => {
  const { base, index } = await fixture({ writeFile: (path, content) => writeFile(path, content, "utf8") });
  t.after(() => rm(base, { recursive: true, force: true }));

  const sessionCount = 200;
  for (let sequence = 0; sequence < sessionCount; sequence += 1) {
    const sessionId = `${String(sequence).padStart(3, "0")}-${"long-session-id-".repeat(12)}`;
    await index.beginSession(sessionId);
    await index.recordUse(sessionId, "shared-generation");
  }

  const sessionFiles = await readdir(index.sessionsDir);
  assert.equal(sessionFiles.length, sessionCount);
  assert.equal((await index.generationUsage("shared-generation")).useSessionCount, sessionCount);
  const recordSizes = await Promise.all([
    stat(index.statePath),
    stat(join(index.generationsDir, "shared-generation.json")),
    ...sessionFiles.map((name) => stat(join(index.sessionsDir, name))),
  ]);
  assert.ok(Math.max(...recordSizes.map(({ size }) => size)) < 512);

  await writeFile(index.statePath, " ".repeat(256 * 1024 + 1), "utf8");
  await assert.rejects(index.completedCount(), /record exceeds 262144 bytes/u);
});

test("migrates large legacy state with raw ids, alias merges, and seed-only generations", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "pi-skill-activity-migration-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "activity");
  const legacyPath = join(base, "skill-activity.json");
  const generation = "11111111-1111-4111-8111-111111111111";
  const seeded = "22222222-2222-4222-8222-222222222222";
  const hashedSession = sessionKey("already-hashed-session");
  await writeFile(legacyPath, JSON.stringify({
    version: 1,
    sessionCount: 2,
    sessionIds: ["raw-session-a", hashedSession],
    completedSessionIds: ["raw-session-a", hashedSession],
    skillSessionIds: {
      verification: ["raw-session-a"],
      [generation]: ["raw-session-a", hashedSession],
    },
    padding: "x".repeat(300_000),
  }), "utf8");
  const index = new SkillActivityIndex(root);
  await index.initialize({
    legacyPath,
    generationAliases: { verification: generation, [generation]: generation },
    generationSeeds: {
      [generation]: { useCount: 5, useSessionCount: 4, lastUsedCompletedSession: 8 },
      [seeded]: { useCount: 3, useSessionCount: 2, lastUsedCompletedSession: 7, lastUsedAt: "2026-01-01T00:00:00.000Z" },
    },
  });

  assert.equal(await index.completedCount(), 2);
  assert.deepEqual(await index.generationUsage(generation), {
    version: 1,
    useCount: 5,
    useSessionCount: 4,
    lastUsedCompletedSession: 8,
  });
  assert.deepEqual(await index.generationUsage(seeded), {
    version: 1,
    useCount: 3,
    useSessionCount: 2,
    lastUsedCompletedSession: 7,
    lastUsedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal((await readdir(index.sessionsDir)).length, 2);
  await index.recordUse("raw-session-a", generation);
  const resumed = await index.generationUsage(generation);
  assert.equal(resumed.useCount, 6);
  assert.equal(resumed.lastUsedCompletedSession, 8);
  await assert.rejects(stat(legacyPath), { code: "ENOENT" });
  assert.equal((await stat(`${legacyPath}.legacy`)).isFile(), true);
});

test("restarts an interrupted legacy migration idempotently", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "pi-skill-activity-migration-recovery-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "activity");
  const legacyPath = join(base, "skill-activity.json");
  const generation = "33333333-3333-4333-8333-333333333333";
  await writeFile(legacyPath, JSON.stringify({
    version: 1,
    sessionCount: 1,
    sessionIds: ["migration-session"],
    completedSessionIds: ["migration-session"],
    skillSessionIds: { [generation]: ["migration-session"] },
  }), "utf8");
  const failurePath = join(root, "skill-activity-index", "generations", `${generation}.json`);
  let failed = false;
  const interrupted = new SkillActivityIndex(root, {
    writeFile: async (path, content) => {
      if (!failed && path === failurePath) {
        failed = true;
        throw new Error("injected migration failure");
      }
      await writeFile(path, content, "utf8");
    },
  });
  await assert.rejects(interrupted.initialize({ legacyPath }), /injected migration failure/u);

  const recovered = new SkillActivityIndex(root);
  await recovered.initialize({ legacyPath });
  assert.equal(await recovered.completedCount(), 1);
  assert.equal((await recovered.generationUsage(generation)).useSessionCount, 1);
  assert.equal((await readdir(recovered.sessionsDir)).length, 1);
  await assert.rejects(stat(recovered.journalPath), { code: "ENOENT" });
});

test("rejects journal traversal and invalid persisted session state", async (t) => {
  const { base, index } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  await writeFile(index.journalPath, JSON.stringify({
    version: 1,
    writes: [{ path: join(index.root, "..", "escaped.json"), value: { version: 1 } }],
  }), "utf8");
  await assert.rejects(new SkillActivityIndex(base).initialize(), /journal path/u);
  await rm(index.journalPath, { force: true });

  await index.beginSession("corrupt-session");
  const path = join(index.sessionsDir, `${sessionKey("corrupt-session")}.json`);
  await writeFile(path, JSON.stringify({ version: 1, usedGenerationIds: [], completedSequence: 9 }), "utf8");
  await assert.rejects(index.recordUse("corrupt-session", "generation-a"), /exceeds activity state/u);
});

test("recovers a partially applied journal after an injected writer failure", async (t) => {
  let failurePath: string | undefined;
  let failed = false;
  const writer = async (path: string, content: string): Promise<void> => {
    if (!failed && path === failurePath) {
      failed = true;
      throw new Error("injected generation write failure");
    }
    await writeFile(path, content, "utf8");
  };
  const { base, index } = await fixture({
    writeFile: writer,
    now: () => new Date("2026-02-03T04:05:06.000Z"),
  });
  t.after(() => rm(base, { recursive: true, force: true }));
  await index.beginSession("interrupted-session");
  failurePath = join(index.generationsDir, "generation-a.json");

  await assert.rejects(index.recordUse("interrupted-session", "generation-a"), /injected generation write failure/u);
  assert.equal(failed, true);
  assert.equal((await stat(index.journalPath)).isFile(), true);
  await assert.rejects(stat(failurePath), { code: "ENOENT" });

  const recovered = new SkillActivityIndex(base);
  await recovered.initialize();
  assert.deepEqual(await recovered.generationUsage("generation-a"), {
    version: 1,
    useCount: 1,
    useSessionCount: 1,
    lastUsedCompletedSession: 1,
    lastUsedAt: "2026-02-03T04:05:06.000Z",
  });
  await assert.rejects(stat(recovered.journalPath), { code: "ENOENT" });
  assert.deepEqual(await recovered.completeSession("interrupted-session"), {
    isNew: true,
    completedCount: 1,
    usedGenerationIds: ["generation-a"],
  });
});
