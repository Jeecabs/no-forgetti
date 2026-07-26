import { createHash } from "node:crypto";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { CAPTURE_SANITIZER_VERSION, type CanonicalEvidenceEntry } from "./types.ts";

const MAX_EVIDENCE_TEXT_CHARS = 16_000;
const INVISIBLE_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/gu,
  /\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S{8,}/giu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
];
const UNSAFE_FENCES = /<\/?(?:project-memory|project-skill|skill)\b[^>]*>/giu;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sanitizeEvidenceText(input: string): string {
  let text = input.replace(/\r\n/g, "\n").replace(INVISIBLE_UNICODE, "");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match) => `[REDACTED secret:${hash(match)}]`);
  }
  text = text.replace(UNSAFE_FENCES, (match) => `[REDACTED fence:${hash(match)}]`);
  if (text.length > MAX_EVIDENCE_TEXT_CHARS) {
    return `${text.slice(0, MAX_EVIDENCE_TEXT_CHARS)}\n[TRUNCATED ${text.length - MAX_EVIDENCE_TEXT_CHARS} chars]`;
  }
  return text;
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return [sanitizeEvidenceText(content)];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): string[] => {
    if (!part || typeof part !== "object") return [];
    const value = part as Record<string, unknown>;
    return value.type === "text" && typeof value.text === "string"
      ? [sanitizeEvidenceText(value.text)]
      : [];
  });
}

function toolCalls(content: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): Array<{ id: string; name: string }> => {
    if (!part || typeof part !== "object") return [];
    const value = part as Record<string, unknown>;
    return value.type === "toolCall" && typeof value.id === "string" && typeof value.name === "string"
      ? [{ id: value.id, name: value.name }]
      : [];
  });
}

function canonicalPayload(entry: SessionEntry): { kind: CanonicalEvidenceEntry["kind"]; payload: Record<string, unknown> } | undefined {
  if (entry.type === "message") {
    const message = entry.message;
    if (message.role === "user") {
      return { kind: "user", payload: { text: textParts(message.content).join("\n") } };
    }
    if (message.role === "assistant") {
      return {
        kind: "assistant",
        payload: {
          text: textParts(message.content).join("\n"),
          toolCalls: toolCalls(message.content),
          stopReason: message.stopReason,
        },
      };
    }
    if (message.role === "toolResult") {
      return {
        kind: "tool",
        payload: {
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError,
        },
      };
    }
    return { kind: "state", payload: { state: "omitted-message", role: message.role } };
  }
  if (entry.type === "compaction") {
    return { kind: "compaction", payload: { summary: sanitizeEvidenceText(entry.summary) } };
  }
  if (entry.type === "branch_summary") {
    return { kind: "branch_summary", payload: { fromId: entry.fromId, summary: sanitizeEvidenceText(entry.summary) } };
  }
  if (entry.type === "model_change") {
    return { kind: "state", payload: { state: "model", provider: entry.provider, modelId: entry.modelId } };
  }
  if (entry.type === "thinking_level_change") {
    return { kind: "state", payload: { state: "thinking", level: entry.thinkingLevel } };
  }
  return { kind: "state", payload: { state: "omitted-entry", entryType: entry.type } };
}

export function canonicalizeEvidenceEntry(
  entry: SessionEntry,
  parentNodeDigest: string | null,
): CanonicalEvidenceEntry | undefined {
  const canonical = canonicalPayload(entry);
  if (!canonical) return undefined;
  const base = {
    sanitizerVersion: CAPTURE_SANITIZER_VERSION,
    sourceEntryId: entry.id,
    parentSourceEntryId: entry.parentId,
    parentNodeDigest,
    timestamp: entry.timestamp,
    kind: canonical.kind,
    payload: canonical.payload,
  };
  return { ...base, nodeDigest: hash(canonicalJson(base)) };
}

export function canonicalEvidenceDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
