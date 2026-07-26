import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { sanitizeEvidenceText } from "../src/capture/sanitizer.ts";
import { CaptureDeltaBuilder } from "../src/capture/tracker.ts";

function user(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: 0 },
  } as SessionEntry;
}

function assistant(id: string, parentId: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private chain of thought" },
        { type: "text", text },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/secret/path" } },
      ],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 1,
    },
  } as SessionEntry;
}

const identity = {
  project: { key: "project-key", canonicalRoot: "/repo", trusted: true },
  producer: { piVersion: "0.81.1", extensionVersion: "0.2.0" },
  sessionId: "raw-session-id",
  generation: "generation-1",
};

test("capture sanitizer redacts secrets and excludes thinking and tool arguments", () => {
  assert.match(sanitizeEvidenceText("api_key=abcdefghijklmnop"), /REDACTED secret/u);
  const entries = [
    user("u1", null, "token secret=abcdefghijklmnop"),
    assistant("a1", "u1", "done"),
  ];
  const builder = new CaptureDeltaBuilder(identity);
  const delta = builder.build(entries, {
    leafId: "a1",
    memoryBranch: "main",
    outcome: "success",
    reason: "agent_settled",
    settledAt: "2026-01-01T00:00:02.000Z",
  });
  const serialized = JSON.stringify(delta);
  assert.doesNotMatch(serialized, /private chain of thought|\/secret\/path|abcdefghijklmnop/u);
  assert.match(serialized, /"name":"read"/u);
  assert.match(serialized, /REDACTED secret/u);
  assert.doesNotMatch(serialized, /raw-session-id/u);
});

test("capture builder sends append deltas and leaf-only checkpoints", () => {
  const entries = [user("u1", null, "one"), assistant("a1", "u1", "done")];
  const builder = new CaptureDeltaBuilder(identity);
  const first = builder.build(entries, {
    leafId: "a1",
    memoryBranch: "main",
    outcome: "success",
    reason: "agent_settled",
    settledAt: "2026-01-01T00:00:02.000Z",
  });
  assert.equal(first.entries.length, 2);
  builder.acknowledge(first);

  const second = builder.build(entries, {
    leafId: "u1",
    memoryBranch: "main",
    outcome: "success",
    reason: "tree",
    settledAt: "2026-01-01T00:00:03.000Z",
  });
  assert.equal(second.entries.length, 0);
  assert.equal(second.afterEntryId, "a1");
  assert.equal(second.checkpoint.leafId, "u1");

  const extended = [...entries, user("u2", "a1", "two")];
  const third = builder.build(extended, {
    leafId: "u2",
    memoryBranch: "main",
    outcome: "success",
    reason: "agent_settled",
    settledAt: "2026-01-01T00:00:04.000Z",
  });
  assert.equal(third.entries.length, 1);
  assert.equal(third.entries[0]?.parentNodeDigest, first.entries[1]?.nodeDigest);
});

test("capture identity is stable across replay timestamps and rejects prefix drift", () => {
  const entries = [user("u1", null, "one")];
  const builder = new CaptureDeltaBuilder(identity);
  const one = builder.build(entries, {
    leafId: "u1",
    memoryBranch: "main",
    outcome: "success",
    reason: "agent_settled",
    settledAt: "2026-01-01T00:00:02.000Z",
  });
  const two = builder.build(entries, {
    leafId: "u1",
    memoryBranch: "main",
    outcome: "success",
    reason: "agent_settled",
    settledAt: "2026-01-02T00:00:02.000Z",
  });
  assert.equal(one.captureId, two.captureId);
  assert.equal(one.contentDigest, two.contentDigest);

  builder.acknowledge(one);
  assert.throws(() => builder.build([user("different", null, "one")], one.checkpoint), /prefix changed/u);
});
