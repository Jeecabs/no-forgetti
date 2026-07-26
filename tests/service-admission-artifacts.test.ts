import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { admissionJsonDigest, createOrCompareJsonFile } from "../src/service/admission-artifacts.ts";

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-admission-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("admission digest is stable under key order and rejects non-JSON values", () => {
  assert.equal(
    admissionJsonDigest({ version: 1, nested: { b: [1, 2], a: null } }),
    admissionJsonDigest({ nested: { a: null, b: [1, 2] }, version: 1 }),
  );
  assert.notEqual(admissionJsonDigest({ a: 1 }), admissionJsonDigest({ a: "1" }));
  assert.throws(() => admissionJsonDigest({ a: Number.NaN }), /non-finite/i);
  assert.throws(() => admissionJsonDigest({ a: undefined } as unknown as object), /undefined/i);
});

test("create-or-compare JSON publication is atomic, bounded, and private", async (t) => {
  const root = await fixture(t);
  const path = join(root, "artifacts", "receipt.json");
  assert.equal(await createOrCompareJsonFile(path, { version: 1, ok: true }, 128), "created");
  assert.equal(await createOrCompareJsonFile(path, { ok: true, version: 1 }, 128), "matching");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(createOrCompareJsonFile(path, { version: 1, ok: false }, 128), /conflicting publication/i);
  await assert.rejects(createOrCompareJsonFile(join(root, "large.json"), { value: "x".repeat(200) }, 128), /exceeds 128 bytes/i);

  await chmod(path, 0o644);
  await assert.rejects(createOrCompareJsonFile(path, { version: 1, ok: true }, 128), /private 0600 file/i);
});
