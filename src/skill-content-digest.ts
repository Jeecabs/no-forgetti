import { createHash } from "node:crypto";

import type { ProjectSkill } from "./skill-types.ts";

export function projectSkillContentDigest(skill: Pick<ProjectSkill, "description" | "content">): string {
  const canonical = JSON.stringify([skill.description, skill.content]);
  return createHash("sha256")
    .update(`no-forgetti/project-skill-content/v1\0${canonical}`, "utf8")
    .digest("hex");
}
