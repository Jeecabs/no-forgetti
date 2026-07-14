import assert from "node:assert/strict";
import test from "node:test";

import { parseSkillReviewPlan } from "../src/skill-review.ts";

const body = "# Procedure\n\n1. Run the check. Completion criterion: it exits successfully.";

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
