const INVISIBLE_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/u,
  /\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S{8,}/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
];
const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:all|any|the|earlier|previous|prior).*instructions?/iu,
  /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/iu,
  /\b(?:assistant|model|you)\s+(?:must|should|need to|are required to)\b/iu,
];

export function validateMemoryText(input: string, maxChars: number): string {
  const text = input.trim().replace(/\r\n/g, "\n");
  if (!text) throw new Error("Memory text cannot be empty.");
  if (text.length > maxChars) throw new Error(`Memory entry exceeds ${maxChars} characters.`);
  if (INVISIBLE_UNICODE.test(text)) throw new Error("Memory entry contains invisible Unicode control characters.");
  if (/<\/?project-memory\b/iu.test(text)) throw new Error("Memory entry cannot contain project-memory fence tags.");
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error("Memory entry looks like a credential or secret. Store secrets outside project memory.");
  }
  if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error("Memory entry looks like prompt manipulation or an instruction addressed to the model.");
  }
  return text;
}

export function safeContextText(input: string): string {
  if (
    INVISIBLE_UNICODE.test(input)
    || /<\/?project-memory\b/iu.test(input)
    || SECRET_PATTERNS.some((pattern) => pattern.test(input))
    || INSTRUCTION_PATTERNS.some((pattern) => pattern.test(input))
  ) {
    return "[BLOCKED: memory entry contained unsafe control, fence, secret-like, or prompt-manipulation content]";
  }
  return input;
}
