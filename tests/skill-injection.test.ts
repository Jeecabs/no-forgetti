import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { buildRetrievedSkillContext, injectRetrievedSkillContext } from "../src/skill-injection.ts";
import type { ProjectSkill } from "../src/skill-types.ts";

const skill: ProjectSkill = {
  name: "verify-releases",
  generationId: "generation-1",
  description: "Verify production releases.",
  content: "# Verify releases\n\n1. Run checks.",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdBy: "background_review",
  updatedBy: "background_review",
  state: "active",
  useCount: 0,
  useSessionCount: 0,
  viewCount: 0,
  patchCount: 0,
  createdSession: 1,
};

function userMessage(content: string): AgentMessage {
  return { role: "user", content, timestamp: 0 };
}

test("builds bounded lower-priority skill context", () => {
  const result = buildRetrievedSkillContext([skill]);
  assert.deepEqual(result.names, ["verify-releases"]);
  assert.match(result.block, /lower-priority procedural guidance/u);
  assert.match(result.block, /<project-skill name="verify-releases">/u);
  assert.match(result.block, /Run checks/u);
});

test("injects into latest user message without exact prompt matching", () => {
  const block = buildRetrievedSkillContext([skill]).block;
  const messages = [
    userMessage("original prompt text"),
    { role: "assistant", content: [], timestamp: 1, stopReason: "stop" },
    userMessage("expanded or transformed prompt text"),
  ] as AgentMessage[];

  const injected = injectRetrievedSkillContext(messages, block);
  assert.ok(injected);
  const latest = injected[2];
  assert.equal(latest?.role, "user");
  assert.match(typeof latest?.content === "string" ? latest.content : "", /expanded or transformed/u);
  assert.match(typeof latest?.content === "string" ? latest.content : "", /verify-releases/u);
  assert.equal(messages[2]?.role === "user" ? messages[2].content : "", "expanded or transformed prompt text");
});

test("preserves multimodal user content and source immutability", () => {
  const block = buildRetrievedSkillContext([skill]).block;
  const image = { type: "image", data: "abc", mimeType: "image/png" } as const;
  const messages = [{
    role: "user",
    content: [{ type: "text", text: "verify this image" }, image],
    timestamp: 0,
  }] as AgentMessage[];
  const source = structuredClone(messages);

  const injected = injectRetrievedSkillContext(messages, block);
  assert.ok(injected);
  const content = injected[0]?.role === "user" ? injected[0].content : undefined;
  assert.equal(Array.isArray(content), true);
  if (!Array.isArray(content)) return;
  assert.deepEqual(content[1], image);
  assert.match(content[2]?.type === "text" ? content[2].text : "", /verify-releases/u);
  assert.deepEqual(messages, source);
});

test("skill injection is idempotent and ignores user-authored fence text", () => {
  const block = buildRetrievedSkillContext([skill]).block;
  const messages = [userMessage("Discuss <project-skill name= syntax")];
  const first = injectRetrievedSkillContext(messages, block);
  assert.ok(first);
  const second = injectRetrievedSkillContext(first, block);
  assert.equal(second, undefined);
});
