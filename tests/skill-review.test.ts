import assert from "node:assert/strict";
import test from "node:test";

import { buildSkillReviewPrompt } from "../src/skill-authoring.ts";
import { parseSkillReviewPlan } from "../src/skill-review.ts";

const body = "# Procedure\n\n1. Run the check. Completion criterion: it exits successfully.";

test("authors skill changes from evidence through the complete doctrine and audit", () => {
  const prompt = buildSkillReviewPrompt({
    transcript: "USER: deployment checks keep drifting between releases",
    skillIndex: "- release-check: Tracer verifies project releases.",
    pendingIndex: "(no pending project skill proposals)",
  });

  const evidenceAt = prompt.indexOf("=== EVIDENCE:");
  const referenceAt = prompt.indexOf("=== AUTHORSHIP REFERENCE ===");
  const processAt = prompt.indexOf("AUTHORSHIP PROCESS");
  const outputAt = prompt.indexOf("OUTPUT CONTRACT:");
  assert.ok(evidenceAt >= 0 && evidenceAt < referenceAt);
  assert.ok(referenceAt < processAt && processAt < outputAt);
  assert.match(prompt, /Predictability/u);
  assert.match(prompt, /leading word/u);
  assert.match(prompt, /completion criterion/u);
  assert.match(prompt, /relevance, duplication, no-op, sediment, sprawl, and negation/u);
  assert.match(prompt, /model-facing trigger sentence, at most 500 characters/u);
  assert.doesNotMatch(prompt, /<=60/u);
  assert.match(prompt, /Return JSON only after completing the authorship audit\.$/u);
});

test("parses one external project-skill proposal", () => {
  assert.deepEqual(parseSkillReviewPlan(JSON.stringify({
    operations: [{
      action: "create",
      name: "verification",
      description: "Run the canonical project verification.",
      content: body,
      reason: "The workflow recurs.",
    }],
  })), {
    operations: [{
      action: "create",
      name: "verification",
      description: "Run the canonical project verification.",
      content: body,
      reason: "The workflow recurs.",
    }],
  });
});

test("allows an empty skill review and rejects multiple operations", () => {
  assert.deepEqual(parseSkillReviewPlan("{\"operations\":[]}"), { operations: [] });
  assert.throws(() => parseSkillReviewPlan(JSON.stringify({ operations: [
    { action: "archive", name: "old" },
    { action: "archive", name: "older" },
  ] })), /at most one/u);
});

test("rejects skill plans missing required fields", () => {
  assert.throws(() => parseSkillReviewPlan(JSON.stringify({ operations: [{ action: "create", name: "x" }] })), /requires description and content/u);
  assert.throws(() => parseSkillReviewPlan(JSON.stringify({ operations: [{ action: "patch", name: "x", oldText: "old" }] })), /requires oldText and newText/u);
});
