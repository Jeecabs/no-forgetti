import {
  MAX_SKILL_CONTENT_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
} from "./skill-types.ts";

const INVISIBLE_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u001B]/u;
const HIJACK_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:all|any|the|earlier|previous|prior).*instructions?/iu,
  /\b(?:reveal|print|leak|exfiltrate)\b.{0,80}\b(?:system prompt|api key|secret|credential)/iu,
  /<\/?(?:system|developer|project-memory|project-skill)\b[^>]*>/iu,
];
const EVIDENCE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;
const EVIDENCE_PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/giu;
const EVIDENCE_TOKEN = /\b(?:(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}|AKIA[0-9A-Z]{16})\b/giu;
const EVIDENCE_SECRET_ASSIGNMENT = /(["']?(?:api[_ -]?key|access[_ -]?token|password|secret|aws_secret_access_key|npm_token|database_url|db_url|[A-Z][A-Z0-9_]*_(?:KEY|SECRET|TOKEN|PASSWORD))["']?\s*[:=]\s*)["']?\S{8,}/giu;
const EVIDENCE_BEARER = /\b(Authorization\s*:\s*Bearer\s+)\S{12,}/giu;
const EVIDENCE_JWT = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const EVIDENCE_CREDENTIAL_URL = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@([^\s]+)/giu;

export interface SanitizedSkillEvidenceText {
  text: string;
  redactionCount: number;
}

function redactSkillSecrets(input: string): SanitizedSkillEvidenceText {
  let redactionCount = 0;
  let text = input.replace(EVIDENCE_PRIVATE_KEY, () => {
    redactionCount += 1;
    return "[REDACTED PRIVATE KEY]";
  });
  text = text.replace(EVIDENCE_SECRET_ASSIGNMENT, (_match, prefix: string) => {
    redactionCount += 1;
    return `${prefix}[REDACTED]`;
  });
  text = text.replace(EVIDENCE_TOKEN, () => {
    redactionCount += 1;
    return "[REDACTED TOKEN]";
  });
  text = text.replace(EVIDENCE_BEARER, (_match, prefix: string) => {
    redactionCount += 1;
    return `${prefix}[REDACTED]`;
  });
  text = text.replace(EVIDENCE_JWT, () => {
    redactionCount += 1;
    return "[REDACTED JWT]";
  });
  text = text.replace(EVIDENCE_CREDENTIAL_URL, (_match, scheme: string, host: string) => {
    redactionCount += 1;
    return `${scheme}[REDACTED]@${host}`;
  });
  return { text, redactionCount };
}

function containsSkillSecret(input: string): boolean {
  return redactSkillSecrets(input).redactionCount > 0;
}

/** Normalize untrusted review evidence and redact the same secrets rejected from exact skill text. */
export function sanitizeSkillEvidenceText(input: string): SanitizedSkillEvidenceText {
  if (typeof input !== "string") throw new Error("Invalid project skill evidence text.");
  const secrets = redactSkillSecrets(input.replace(/\r\n?/gu, "\n").normalize("NFC"));
  let redactionCount = secrets.redactionCount;
  const text = secrets.text.replace(EVIDENCE_CONTROL, () => {
    redactionCount += 1;
    return "\uFFFD";
  });
  return { text, redactionCount };
}

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
  if (INVISIBLE_UNICODE.test(normalized) || UNSAFE_CONTROL.test(normalized)) throw new Error("Skill description contains unsafe control characters.");
  if (containsSkillSecret(normalized)) throw new Error("Skill description looks like a credential or secret.");
  if (HIJACK_PATTERNS.some((pattern) => pattern.test(normalized))) throw new Error("Skill description looks like prompt manipulation or unsafe context.");
  if (!normalized.endsWith(".")) throw new Error("Skill description must end with a period.");
  if (normalized.length > MAX_SKILL_DESCRIPTION_CHARS) {
    throw new Error(`Skill description exceeds ${MAX_SKILL_DESCRIPTION_CHARS} characters.`);
  }
  return normalized;
}

export function validateSkillMetadataText(value: string, maxChars = 500): string {
  const normalized = value.trim().replace(/\r\n/g, "\n");
  if (!normalized) throw new Error("Skill proposal metadata cannot be empty.");
  if (normalized.length > maxChars) throw new Error(`Skill proposal metadata exceeds ${maxChars} characters.`);
  if (INVISIBLE_UNICODE.test(normalized) || UNSAFE_CONTROL.test(normalized)) {
    throw new Error("Skill proposal metadata contains unsafe control characters.");
  }
  if (containsSkillSecret(normalized)) {
    throw new Error("Skill proposal metadata looks like a credential or secret.");
  }
  if (HIJACK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new Error("Skill proposal metadata looks like prompt manipulation or unsafe context.");
  }
  return normalized;
}

export function validateSkillContent(content: string): string {
  const normalized = content.trim().replace(/\r\n/g, "\n");
  if (!normalized) throw new Error("Skill content cannot be empty.");
  if (normalized.length > MAX_SKILL_CONTENT_CHARS) {
    throw new Error(`Skill content exceeds ${MAX_SKILL_CONTENT_CHARS} characters.`);
  }
  if (INVISIBLE_UNICODE.test(normalized) || UNSAFE_CONTROL.test(normalized)) {
    throw new Error("Skill content contains unsafe control characters.");
  }
  if (containsSkillSecret(normalized)) {
    throw new Error("Skill content looks like a credential or secret.");
  }
  if (HIJACK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new Error("Skill content looks like prompt manipulation or unsafe context.");
  }
  return normalized;
}

/** Extra package-shape constraints for model-authored skill bodies. */
export function validateGeneratedSkillContent(content: string): string {
  const normalized = validateSkillContent(content);
  if (/^---(?:\n|$)/u.test(normalized)) {
    throw new Error("Generated skill content must not contain frontmatter.");
  }
  if (/\bdisable-model-invocation\b/iu.test(normalized)) {
    throw new Error("Generated skill content must not set invocation-control frontmatter.");
  }
  if (/\bGLOSSARY\.md\b|\breferences?\//imu.test(normalized)) {
    throw new Error("Generated project skills must remain one self-contained SKILL.md body.");
  }
  return normalized;
}

