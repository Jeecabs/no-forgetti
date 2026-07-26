import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadServiceConfig, parseServiceConfig } from "../src/service/config.ts";

test("service config defaults to embedded authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-config-"));
  assert.deepEqual(await loadServiceConfig(root), { version: 1, mode: "embedded", evidenceTtlHours: 24 });
});

test("external authority requires an explicit reviewer without secrets", () => {
  assert.throws(() => parseServiceConfig({ version: 1, mode: "external" }), /requires a reviewer/u);
  const config = parseServiceConfig({
    version: 1,
    mode: "external",
    evidenceTtlHours: 12,
    reviewer: { provider: "anthropic", model: "review-model", reasoningEffort: "high" },
  });
  assert.equal(config.reviewer?.provider, "anthropic");
  assert.equal(config.reviewer?.maxCallsPerDay, 100);
  assert.equal(JSON.stringify(config).includes("apiKey"), false);
  assert.throws(() => parseServiceConfig({
    version: 1,
    mode: "external",
    reviewer: { provider: "anthropic", model: "review-model", apiKey: "must-not-live-here" },
  }), /reviewer profile fields: apiKey/u);
  assert.throws(() => parseServiceConfig({
    version: 1,
    mode: "external",
    reviewer: { provider: "anthropic", model: "review-model", maxCallsPerDay: 0.5 },
  }), /call budget/u);
  assert.throws(() => parseServiceConfig({ version: 1, mode: "embedded", typo: true }), /service config fields: typo/u);
});

test("service config refuses oversized input before parsing", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-config-"));
  const dir = join(root, "no-forgetti");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "service.json"), "x".repeat(64 * 1024 + 1));
  await assert.rejects(loadServiceConfig(root), /exceeds/u);
});
