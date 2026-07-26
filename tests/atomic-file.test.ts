import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { atomicCreateFile } from "../src/atomic-file.ts";

test("atomicCreateFile publishes once and compares exact replays", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "no-forgetti-atomic-"));
  const path = join(root, "nested", "record.json");

  assert.equal(await atomicCreateFile(path, "first\n"), "created");
  assert.equal(await atomicCreateFile(path, "first\n"), "duplicate");
  await assert.rejects(() => atomicCreateFile(path, "different\n"), /conflicting immutable/i);
  assert.equal(await readFile(path, "utf8"), "first\n");
});
