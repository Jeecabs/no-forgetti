import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runServiceCli } from "../src/service/cli.ts";
import { loadServiceConfig, parseServiceConfig } from "../src/service/config.ts";
import { createReviewJob } from "../src/service/protocol.ts";
import { ReviewSpool } from "../src/service/spool.ts";
import type { MemoryBranch } from "../src/types.ts";

test("service config defaults to embedded authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-config-"));
  assert.deepEqual(await loadServiceConfig(root), { version: 1, mode: "embedded", evidenceTtlHours: 24 });
});

test("disabled mode needs no reviewer and preserves optional review settings", () => {
  assert.deepEqual(parseServiceConfig({ version: 1, mode: "disabled" }), {
    version: 1,
    mode: "disabled",
    evidenceTtlHours: 24,
  });
  assert.equal(parseServiceConfig({
    version: 1,
    mode: "disabled",
    reviewer: { provider: "anthropic", model: "review-model" },
  }).reviewer?.model, "review-model");
});

test("disabled review worker drains no jobs without reviewer configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-config-"));
  const dir = join(root, "no-forgetti");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "service.json"), JSON.stringify({ version: 1, mode: "disabled" }));
  const branch: MemoryBranch = {
    version: 1,
    name: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    entries: [],
  };
  const pendingJob = createReviewJob({
    projectKey: "a".repeat(24),
    sessionId: "disabled-worker-test",
    throughEntryId: "assistant-1",
    transcript: "USER: Remember the canonical check.",
    branch,
    maxChars: 4_000,
  });
  const spool = new ReviewSpool(join(dir, "review-spool"));
  await spool.initialize();
  assert.equal(await spool.enqueue(pendingJob), "enqueued");
  let output = "";
  const code = await runServiceCli(["review", "--once", "--agent-dir", root], {
    stdout: { write: (chunk) => { output += String(chunk); return true; } },
    stderr: { write: () => true },
  });
  assert.equal(code, 0);
  assert.match(output, /"type":"drained"/u);
  assert.match(output, /"completed":0/u);
  const activities = await spool.inspect([pendingJob.id]);
  assert.equal(activities.length, 1);
  const [activity] = activities;
  assert.equal(activity?.state, "queued");
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
