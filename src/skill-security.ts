import {
  MAX_SKILL_CONTENT_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
} from "./skill-types.ts";

const INVISIBLE_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/u,
  /\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S{8,}/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
];
const HIJACK_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:all|any|the|earlier|previous|prior).*instructions?/iu,
  /\b(?:reveal|print|leak|exfiltrate)\b.{0,80}\b(?:system prompt|api key|secret|credential)/iu,
  /<\/?(?:system|developer|project-memory|project-skill)\b[^>]*>/iu,
];

export function validateSkillName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(normalized)) {
    throw new Error("Skill names must be lowercase hyphenated words.");
  }
  if (normalized.length > 64) throw new Error("Skill name exceeds 64 characters.");
  return normalized;
}

export function validateSkillDescription(description: string): string {
  const normalized = description.trim().replace(/\r\n/g, "\n");
  if (!normalized) throw new Error("Skill description cannot be empty.");
  if (normalized.includes("\n")) throw new Error("Skill description must be one sentence.");
  if (INVISIBLE_UNICODE.test(normalized)) throw new Error("Skill description contains invisible Unicode control characters.");
  if (SECRET_PATTERNS.some((pattern) => pattern.test(normalized))) throw new Error("Skill description looks like a credential or secret.");
  if (HIJACK_PATTERNS.some((pattern) => pattern.test(normalized))) throw new Error("Skill description looks like prompt manipulation or unsafe context.");
  if (!normalized.endsWith(".")) throw new Error("Skill description must end with a period.");
  if (normalized.length > MAX_SKILL_DESCRIPTION_CHARS) {
    throw new Error(`Skill description exceeds ${MAX_SKILL_DESCRIPTION_CHARS} characters.`);
  }
  return normalized;
}

export function validateSkillContent(content: string): string {
  const normalized = content.trim().replace(/\r\n/g, "\n");
  if (!normalized) throw new Error("Skill content cannot be empty.");
  if (normalized.length > MAX_SKILL_CONTENT_CHARS) {
    throw new Error(`Skill content exceeds ${MAX_SKILL_CONTENT_CHARS} characters.`);
  }
  if (INVISIBLE_UNICODE.test(normalized)) {
    throw new Error("Skill content contains invisible Unicode control characters.");
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new Error("Skill content looks like a credential or secret.");
  }
  if (HIJACK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new Error("Skill content looks like prompt manipulation or unsafe context.");
  }
  return normalized;
}

