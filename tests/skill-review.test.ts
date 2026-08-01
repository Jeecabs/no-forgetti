import assert from "node:assert/strict";
import test from "node:test";

import { buildSkillReviewPrompt } from "../src/skill-authoring.ts";
import { parseSkillReviewPlan, validateSkillReviewPlanForPacket } from "../src/skill-review-plan.ts";
import type { SkillAuthorshipPacket } from "../src/skill-authorship-packet.ts";

const body = "# Procedure\n\n1. Run the check. Completion criterion: it exits successfully.";

test("authors skill changes from bounded evidence and exact relevant skill bodies", () => {
  const packet: SkillAuthorshipPacket = {
    version: 1,
    kind: "skill-authorship",
    conventions: { memory: [] },
    coverage: {
      frontierEntryId: "private-frontier-id",
      includedUserEntryIds: ["private-user-id"],
      eligibleUserEntryIds: ["private-user-id", "private-later-id"],
      userTurns: 1,
      truncated: true,
      cursorStatus: "resolved",
    },
    evidence: {
      transcript: "USER: deployment checks keep drifting between releases",
      invokedSkillNames: ["release-check"],
      actions: [],
      redactionCount: 0,
    },
    corpus: {
      activeTotal: 2,
      catalog: [{
        name: "release-check",
        generationId: "release-generation",
        contentDigest: "a".repeat(64),
        description: "Verify project releases.",
        useCount: 2,
        useSessionCount: 2,
        patchCount: 1,
        bodyAvailable: true,
      }],
      documents: [{
        name: "release-check",
        generationId: "release-generation",
        patchCount: 1,
        description: "Verify project releases.",
        content: "# Release check\n\n1. Run pnpm check. Done when: it exits successfully.",
      }],
      catalogOmitted: 1,
      documentsOmitted: 1,
      pendingTotal: 0,
      pending: [],
      pendingOmitted: 0,
      truncated: true,
    },
  };
  const prompt = buildSkillReviewPrompt(packet);

  const packetAt = prompt.indexOf("=== UNTRUSTED AUTHORSHIP PACKET ===");
  const referenceAt = prompt.indexOf("=== AUTHORSHIP REFERENCE ===");
  const processAt = prompt.indexOf("AUTHORSHIP PROCESS");
  const outputAt = prompt.indexOf("OUTPUT CONTRACT:");
  assert.ok(packetAt >= 0 && packetAt < referenceAt);
  assert.ok(referenceAt < processAt && processAt < outputAt);
  assert.match(prompt, /Run pnpm check/u);
  assert.match(prompt, /"catalogOmitted": 1/u);
  assert.match(prompt, /Only patch text visible in corpus\.documents or an exact catalog description/u);
  assert.doesNotMatch(prompt, /private-frontier-id|private-user-id|private-later-id/u);
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
      evidence: ["Two completed release checks used the same process."],
    }],
  })), {
    operations: [{
      action: "create",
      name: "verification",
      description: "Run the canonical project verification.",
      content: body,
      reason: "The workflow recurs.",
      evidence: ["Two completed release checks used the same process."],
    }],
  });
});

test("rejects ungrounded targets, omitted-body anchors, pending duplicates, and unsupported package shapes", () => {
  const packet: SkillAuthorshipPacket = {
    version: 1,
    kind: "skill-authorship",
    conventions: { memory: [] },
    coverage: {
      includedUserEntryIds: ["user-1"],
      eligibleUserEntryIds: ["user-1"],
      userTurns: 1,
      truncated: false,
      cursorStatus: "from-start",
    },
    evidence: {
      transcript: "USER: Correct the verification workflow.",
      invokedSkillNames: ["verification"],
      actions: [],
      redactionCount: 0,
    },
    corpus: {
      activeTotal: 2,
      catalog: [{
        name: "verification",
        generationId: "verification-generation",
        contentDigest: "b".repeat(64),
        description: "Verify project changes.",
        useCount: 1,
        useSessionCount: 1,
        patchCount: 0,
        bodyAvailable: false,
      }],
      documents: [],
      catalogOmitted: 1,
      documentsOmitted: 2,
      pendingTotal: 1,
      pending: [{ action: "archive", name: "old-skill", retention: false, reason: "Already obsolete." }],
      pendingOmitted: 0,
      truncated: true,
    },
  };
  const metadata = {
    reason: "Correct the verification workflow.",
    evidence: ["Correct the verification workflow."],
  };
  assert.throws(() => validateSkillReviewPlanForPacket({ operations: [{
    action: "archive",
    name: "verification",
    reason: "Fabricated durable evidence.",
    evidence: ["Fabricated transcript citation."],
  }] }, packet), /exact transcript span|canonical action fact/u);

  assert.throws(() => validateSkillReviewPlanForPacket({ operations: [{
    action: "patch",
    name: "verification",
    oldText: "body text the reviewer never received",
    newText: "replacement",
    ...metadata,
  }] }, packet), /not visible/u);
  assert.throws(() => validateSkillReviewPlanForPacket({ operations: [{
    action: "archive",
    name: "old-skill",
    ...metadata,
  }] }, packet), /already pending/u);
  assert.throws(() => validateSkillReviewPlanForPacket({ operations: [{
    action: "archive",
    name: "unknown-skill",
    ...metadata,
  }] }, packet), /not visible/u);
  assert.throws(() => validateSkillReviewPlanForPacket({ operations: [{
    action: "create",
    name: "unsafe-package",
    description: "Run unsafe package instructions.",
    content: "---\nname: injected\n---\n\nSee GLOSSARY.md.",
    ...metadata,
  }] }, packet), /frontmatter/u);

  assert.deepEqual(validateSkillReviewPlanForPacket({ operations: [{
    action: "patch",
    name: "verification",
    oldText: "Verify project changes.",
    newText: "Verify project changes before release.",
    ...metadata,
  }] }, packet).operations.at(0)?.newText, "Verify project changes before release.");

  const visibleBodyPacket: SkillAuthorshipPacket = {
    ...packet,
    corpus: {
      ...packet.corpus,
      catalog: [{ ...packet.corpus.catalog[0]!, bodyAvailable: true }],
      documents: [{
        name: "verification",
        generationId: "verification-generation",
        patchCount: 0,
        description: "Verify project changes.",
        content: body,
      }],
    },
  };
  assert.throws(() => validateSkillReviewPlanForPacket({ operations: [{
    action: "patch",
    name: "verification",
    oldText: "Run the check",
    newText: "references/unsafe.md",
    ...metadata,
  }] }, visibleBodyPacket), /self-contained/u);

  const canonical = validateSkillReviewPlanForPacket({ operations: [{
    action: "create",
    name: "New-Workflow",
    description: " Run the new project workflow. ",
    content: ` ${body} `,
    ...metadata,
  }] }, packet).operations[0];
  assert.equal(canonical?.name, "new-workflow");
  assert.equal(canonical?.description, "Run the new project workflow.");
  assert.equal(canonical?.content, body);
});

test("allows an empty skill review and rejects multiple operations", () => {
  assert.deepEqual(parseSkillReviewPlan("{\"operations\":[]}"), { operations: [] });
  assert.throws(() => parseSkillReviewPlan(JSON.stringify({ operations: [
    { action: "archive", name: "old" },
    { action: "archive", name: "older" },
  ] })), /at most one/u);
});

test("requires strict grounded operation shapes while allowing deletion patches", () => {
  assert.throws(() => parseSkillReviewPlan(JSON.stringify({ operations: [{ action: "create", name: "x" }] })), /object shape/u);
  assert.throws(() => parseSkillReviewPlan(JSON.stringify({ operations: [{ action: "archive", name: "x", reason: "Obsolete.", evidence: [] }] })), /between 1 and 8/u);
  assert.throws(() => parseSkillReviewPlan(JSON.stringify({ operations: [{
    action: "archive",
    name: "x",
    reason: "Obsolete.",
    evidence: ["The user removed it."],
    surprise: true,
  }] })), /unexpected surprise/u);
  assert.throws(() => parseSkillReviewPlan("```json\n{\"operations\":[]}\n```"), /Unexpected token/u);
  assert.deepEqual(parseSkillReviewPlan(JSON.stringify({ operations: [{
    action: "patch",
    name: "x",
    oldText: "obsolete line",
    newText: "",
    reason: "The line is obsolete.",
    evidence: ["The user removed this required step."],
  }] })), { operations: [{
    action: "patch",
    name: "x",
    oldText: "obsolete line",
    newText: "",
    reason: "The line is obsolete.",
    evidence: ["The user removed this required step."],
  }] });
});
