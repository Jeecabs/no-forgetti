import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withFileLock } from "../src/file-lock.ts";

test("reaps a stale lock only when its owner process is dead", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "no-forgetti-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lock = join(dir, ".lock");
  await writeFile(lock, "99999999:dead-owner\n0\n");
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);

  const result = await withFileLock(lock, 500, 10, "test", async () => "ok");
  assert.equal(result, "ok");
  await assert.rejects(stat(lock), /ENOENT/u);
});

test("never evicts a live owner solely because its lock is old", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "no-forgetti-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lock = join(dir, ".lock");
  const owner = `${process.pid}:live-owner\n0\n`;
  await writeFile(lock, owner);
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);

  await assert.rejects(withFileLock(lock, 60, 10, "test", async () => undefined), /Timed out/u);
  assert.equal(await readFile(lock, "utf8"), owner);
});
