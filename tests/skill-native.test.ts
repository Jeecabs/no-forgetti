import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import {
  projectSkillNameFromInvocation,
  projectSkillNameFromReadPath,
} from "../src/skill-native.ts";

const cwd = "/tmp/project";
const skillsDir = "/tmp/no-forgetti/skills";
const skillPath = join(skillsDir, "verification", "SKILL.md");

test("recognizes only native reads of active project skill packages", () => {
  assert.equal(projectSkillNameFromReadPath({ path: skillPath, cwd, skillsDir }), "verification");
  assert.equal(projectSkillNameFromReadPath({ path: `@${skillPath}`, cwd, skillsDir }), "verification");
  assert.equal(projectSkillNameFromReadPath({ path: join(skillsDir, ".archive", "verification", "SKILL.md"), cwd, skillsDir }), undefined);
  assert.equal(projectSkillNameFromReadPath({ path: join(skillsDir, "verification", "references.md"), cwd, skillsDir }), undefined);
  assert.equal(projectSkillNameFromReadPath({ path: "/tmp/other/verification/SKILL.md", cwd, skillsDir }), undefined);
});

test("recognizes persisted Pi skill invocations by their project skill location", () => {
  const message = {
    role: "user",
    content: [{
      type: "text",
      text: `<skill name="verification" location="${skillPath}">\nReferences are relative to ${join(skillsDir, "verification")}.\n\n# Verification\n</skill>\n\nrun checks`,
    }],
    timestamp: 0,
  } as AgentMessage;
  assert.equal(projectSkillNameFromInvocation({ message, cwd, skillsDir }), "verification");

  const mismatch = structuredClone(message);
  if (mismatch.role === "user" && Array.isArray(mismatch.content) && mismatch.content[0]?.type === "text") {
    mismatch.content[0].text = mismatch.content[0].text.replace('name="verification"', 'name="other"');
  }
  assert.equal(projectSkillNameFromInvocation({ message: mismatch, cwd, skillsDir }), undefined);
});
