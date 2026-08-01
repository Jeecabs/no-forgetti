import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSkillConventionSnapshot } from "../src/skill-conventions.ts";
import type { MemoryBranch } from "../src/types.ts";

function memory(entries: string[]): MemoryBranch {
  return {
    version: 1,
    name: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    entries: entries.map((text, index) => ({
      id: `memory-${index}`,
      text,
      importance: index === 0 ? "high" : "normal",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
  };
}

test("captures bounded manifest facts and safe project-memory beliefs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-skill-conventions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({
    packageManager: "pnpm@10.28.2",
    scripts: {
      test: "node --test tests/*.test.ts",
      check: "tsc --noEmit",
      deploy: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    },
  }));
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  const snapshot = await buildSkillConventionSnapshot({
    projectRoot: root,
    memory: memory([
      "Release verification uses pnpm check.",
      "AWS_SECRET_ACCESS_KEY=must-not-leak-value",
    ]),
  });

  assert.deepEqual(snapshot.manifest, {
    packageManager: "pnpm@10.28.2",
    lockfiles: ["pnpm-lock.yaml"],
    scripts: [
      { name: "check", command: "tsc --noEmit" },
      { name: "test", command: "node --test tests/*.test.ts" },
    ],
  });
  assert.deepEqual(snapshot.memory, [{ importance: "high", text: "Release verification uses pnpm check." }]);
  assert.doesNotMatch(JSON.stringify(snapshot), /must-not-leak|abcdefghijklmnopqrstuvwxyz/u);
});

test("returns an empty bounded snapshot when project conventions are unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-skill-conventions-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await buildSkillConventionSnapshot({ projectRoot: root }), {
    memory: [],
  });
});
