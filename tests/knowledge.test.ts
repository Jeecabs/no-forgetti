import assert from "node:assert/strict";
import test from "node:test";

import {
  countIndependentEvidence,
  evaluateActivation,
  evidenceContribution,
  resolveApplicableClaims,
} from "../src/knowledge/policy.ts";
import { buildKnowledgeProjection } from "../src/knowledge/projection.ts";
import type { Claim, Evidence, KnowledgeEvent } from "../src/knowledge/types.ts";

const NOW = "2026-02-01T00:00:00.000Z";
const strong = { truth: 0.97, extraction: 0.98, scope: 0.96 } as const;

function makeEvidence(id: string, overrides: Partial<Evidence> = {}): Evidence {
  return {
    id,
    content: `support for ${id}`,
    observedAt: "2026-01-20T00:00:00.000Z",
    source: { kind: "observation", id: `source-${id}` },
    confidence: strong,
    commonness: 0.9,
    ...overrides,
  };
}

function makeClaim(id: string, overrides: Partial<Claim> = {}): Claim {
  return {
    id,
    key: id,
    statement: `Claim ${id}`,
    locus: { kind: "project", projectId: "project-1" },
    validity: { status: "current" },
    evidenceIds: [`e-${id}`],
    commonness: 0.9,
    confidence: strong,
    importance: "normal",
    applicability: {},
    freshness: { asOf: "2026-01-20T00:00:00.000Z" },
    utility: 0.8,
    ...overrides,
  };
}

test("activates a rare critical deploy invariant from one independent observation", () => {
  const evidence = makeEvidence("deploy-observation", { commonness: 0.03 });
  const invariant = makeClaim("deploy-invariant", {
    statement: "Never deploy without rollback verification.",
    evidenceIds: [evidence.id],
    commonness: 0.03,
    importance: "critical",
    utility: 1,
  });

  const decision = evaluateActivation(invariant, [evidence], { now: NOW });
  assert.equal(decision.active, true);
  assert.equal(decision.independentEvidenceCount, 1);
});

test("cloned pnpm mentions do not become independent support", () => {
  const clones = ["a", "b", "c"].map((suffix) => makeEvidence(`pnpm-${suffix}`, {
    source: { kind: "document", id: `copy-${suffix}` },
    derivedFromEvidence: ["original-pnpm-mention"],
  }));
  const preference = makeClaim("pnpm-preference", {
    statement: "Prefer pnpm for package operations.",
    evidenceIds: clones.map((item) => item.id),
    importance: "low",
  });

  assert.equal(countIndependentEvidence(clones), 1);
  const decision = evaluateActivation(preference, clones, { now: NOW });
  assert.equal(decision.active, false);
  assert.equal(decision.reason, "insufficient-common-support");
  assert.equal(decision.independentCommonEvidenceCount, 1);
});

test("activates a common low-importance preference without inflating importance", () => {
  const evidence = [makeEvidence("pnpm-package-json"), makeEvidence("pnpm-lockfile")];
  const preference = makeClaim("common-pnpm", {
    statement: "Prefer pnpm for package operations.",
    evidenceIds: evidence.map((item) => item.id),
    commonness: 0.95,
    importance: "low",
    utility: 0.4,
  });

  const decision = evaluateActivation(preference, evidence, { now: NOW });
  assert.equal(decision.active, true);
  assert.equal(preference.importance, "low");
  assert.equal(decision.independentCommonEvidenceCount, 2);
});

test("exact-file exception overrides its project rule at runtime", () => {
  const projectRule = makeClaim("project-package-manager", {
    key: "package-manager",
    statement: "Use pnpm.",
  });
  const fileException = makeClaim("package-lock-exception", {
    key: "package-manager",
    statement: "Use npm when updating this fixture.",
    locus: { kind: "file", projectId: "project-1", path: "fixtures/npm/package-lock.json" },
  });

  const exact = resolveApplicableClaims([projectRule, fileException], {
    projectId: "project-1",
    filePath: "./fixtures/npm/package-lock.json",
    at: NOW,
  });
  assert.deepEqual(exact.map((claim) => claim.id), [fileException.id]);

  const elsewhere = resolveApplicableClaims([projectRule, fileException], {
    projectId: "project-1",
    filePath: "src/index.ts",
    at: NOW,
  });
  assert.deepEqual(elsewhere.map((claim) => claim.id), [projectRule.id]);
});

test("memory-derived evidence contributes zero truth and commonness", () => {
  const copiedMemory = makeEvidence("remembered-deploy-rule", {
    source: { kind: "memory", id: "memory-record-1" },
    derivedFromMemory: ["main:entry-7", "review:entry-2"],
    confidence: { truth: 1, extraction: 0.99, scope: 0.98 },
    commonness: 1,
  });
  const contribution = evidenceContribution(copiedMemory);
  assert.equal(contribution.truth, 0);
  assert.equal(contribution.commonness, 0);
  assert.equal(contribution.extraction, 0.99);

  const claim = makeClaim("remembered-only", {
    evidenceIds: [copiedMemory.id],
    importance: "critical",
  });
  const decision = evaluateActivation(claim, [copiedMemory], { now: NOW });
  assert.equal(decision.active, false);
  assert.equal(decision.reason, "no-independent-evidence");
});

test("projection withholds contested claims, ranks late, and enforces both budgets", () => {
  const criticalEvidence = makeEvidence("critical", { commonness: 0.05 });
  const preferenceEvidence = [makeEvidence("pref-a"), makeEvidence("pref-b")];
  const critical = makeClaim("critical", {
    statement: "Never deploy without rollback verification.",
    evidenceIds: [criticalEvidence.id],
    commonness: 0.05,
    importance: "critical",
    utility: 1,
  });
  const preference = makeClaim("preference", {
    statement: "Prefer pnpm for package operations.",
    evidenceIds: preferenceEvidence.map((item) => item.id),
    importance: "low",
  });
  const contested = makeClaim("contested", {
    statement: "Skip release verification.",
    evidenceIds: [criticalEvidence.id],
    importance: "critical",
    validity: { status: "contested", since: "2026-01-25T00:00:00.000Z" },
  });
  const input = {
    claims: [preference, contested, critical],
    evidence: [criticalEvidence, ...preferenceEvidence],
    context: { projectId: "project-1", filePath: "src/release.ts", at: NOW },
  } as const;

  const criticalLine = `- ${critical.statement}`;
  const byChars = buildKnowledgeProjection({
    ...input,
    budget: { maxChars: criticalLine.length, maxTokens: 1_000 },
  });
  assert.deepEqual(byChars.selected.map((item) => item.claim.id), [critical.id]);
  assert.equal(byChars.text, criticalLine);
  assert.equal(byChars.usedChars <= criticalLine.length, true);
  assert.equal(byChars.withheld.some((item) => item.claimId === contested.id && item.reason === "contested"), true);

  const words = (text: string) => text === "" ? 0 : text.split(/\s+/u).length;
  const byTokens = buildKnowledgeProjection({
    ...input,
    budget: { maxChars: 1_000, maxTokens: words(criticalLine) },
    estimateTokens: words,
  });
  assert.deepEqual(byTokens.selected.map((item) => item.claim.id), [critical.id]);
  assert.equal(byTokens.estimatedTokens, words(criticalLine));
  assert.equal(byTokens.withheld.some((item) => item.claimId === preference.id && item.reason === "token-budget"), true);
});

test("exposure, selection, and application do not imply truth; verification and correction are explicit", () => {
  const evidence = makeEvidence("single-common-source");
  const claim = makeClaim("eventful-preference", {
    evidenceIds: [evidence.id],
    importance: "low",
  });
  const neutralEvents: KnowledgeEvent[] = [
    { id: "exposure-1", claimId: claim.id, type: "exposure", at: NOW },
    { id: "selected-1", claimId: claim.id, type: "selected", at: NOW, rank: 1 },
    { id: "applied-1", claimId: claim.id, type: "applied", at: NOW },
  ];
  assert.equal(evaluateActivation(claim, [evidence], { now: NOW, events: neutralEvents }).active, false);

  const verified: KnowledgeEvent = { id: "verified-1", claimId: claim.id, type: "verified", at: NOW };
  assert.equal(evaluateActivation(claim, [evidence], { now: NOW, events: [...neutralEvents, verified] }).active, true);

  const corrected: KnowledgeEvent = { id: "corrected-1", claimId: claim.id, type: "corrected", at: NOW };
  const correctedDecision = evaluateActivation(claim, [evidence], {
    now: NOW,
    events: [...neutralEvents, verified, corrected],
  });
  assert.equal(correctedDecision.active, false);
  assert.equal(correctedDecision.reason, "corrected");
});
