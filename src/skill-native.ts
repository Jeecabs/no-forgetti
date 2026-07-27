import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";

export const PROJECT_SKILL_USE_ENTRY = "no-forgetti-project-skill-use";

const DIRECT_SKILL_FILE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/u;

interface NativeSkillLocation {
  cwd: string;
  skillsDir: string;
}

function resolveObservedPath(path: string, cwd: string): string {
  const withoutRefPrefix = path.startsWith("@") ? path.slice(1) : path;
  if (withoutRefPrefix === "~") return homedir();
  if (withoutRefPrefix.startsWith(`~${sep}`)) return join(homedir(), withoutRefPrefix.slice(2));
  return resolve(cwd, withoutRefPrefix);
}

export function projectSkillNameFromReadPath(
  request: NativeSkillLocation & { path: string },
): string | undefined {
  const skillsDir = resolve(request.skillsDir);
  const path = resolveObservedPath(request.path, request.cwd);
  const nestedPath = relative(skillsDir, path).split(sep).join("/");
  return nestedPath.match(DIRECT_SKILL_FILE)?.at(1);
}

function userText(message: AgentMessage): string | undefined {
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function projectSkillNameFromInvocation(
  request: NativeSkillLocation & { message: AgentMessage },
): string | undefined {
  const match = userText(request.message)?.match(/^<skill name="([^"]+)" location="([^"]+)">\n/u);
  if (!match) return undefined;
  const storedName = projectSkillNameFromReadPath({ ...request, path: match[2]! });
  return storedName === match[1] ? storedName : undefined;
}
