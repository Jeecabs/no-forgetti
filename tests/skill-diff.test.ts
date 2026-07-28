import assert from "node:assert/strict";
import test from "node:test";

import { renderSkillChange } from "../src/skill-diff.ts";

test("reports identical bodies as unchanged", () => {
  assert.equal(renderSkillChange("a\nb\n", "a\nb\n"), "(no change)");
});

test("renders an anchored replacement with surrounding context", () => {
  const before = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight";
  const after = before.replace("five", "FIVE");
  assert.equal(renderSkillChange(before, after, 2), [
    "  three",
    "  four",
    "- five",
    "+ FIVE",
    "  six",
    "  seven",
  ].join("\n"));
});

test("renders a change at the very start without leading context", () => {
  assert.equal(renderSkillChange("a\nb\nc", "A\nb\nc", 2), ["- a", "+ A", "  b", "  c"].join("\n"));
});

test("renders a change at the very end without trailing context", () => {
  assert.equal(renderSkillChange("a\nb\nc", "a\nb\nC", 1), ["  b", "- c", "+ C"].join("\n"));
});

test("renders additions against an empty body", () => {
  assert.equal(renderSkillChange("", "new line", 2), ["- ", "+ new line"].join("\n"));
});

test("renders a missing trailing newline as a change", () => {
  assert.equal(renderSkillChange("a\nb\n", "a\nb", 1), ["  b", "- "].join("\n"));
});

test("caps a whole-body rewrite", () => {
  const before = Array.from({ length: 200 }, (_, index) => `old ${index}`).join("\n");
  const after = Array.from({ length: 200 }, (_, index) => `new ${index}`).join("\n");
  const lines = renderSkillChange(before, after).split("\n");
  assert.equal(lines.length, 61);
  assert.equal(lines.at(0), "- old 0");
  assert.equal(lines.at(-1), "… 340 more lines");
});
