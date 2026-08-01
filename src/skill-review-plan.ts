import type { SkillAuthorshipPromptPacket } from "./skill-authorship-packet.ts";
import {
  validateGeneratedSkillContent,
  validateSkillContent,
  validateSkillDescription,
  validateSkillMetadataText,
  validateSkillName,
} from "./skill-security.ts";
import { MAX_SKILL_CONTENT_CHARS, type SkillOperation, type SkillReviewPlan } from "./skill-types.ts";
import { exactKeys, isRecord } from "./state-validation.ts";

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`Skill review operation requires ${key}.`);
  return field;
}

function requiredEvidence(value: Record<string, unknown>): string[] {
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 8) {
    throw new Error("Skill review evidence must contain between 1 and 8 items.");
  }
  if (!value.evidence.every((item) => typeof item === "string")) {
    throw new Error("Skill review evidence items must be strings.");
  }
  return [...value.evidence] as string[];
}

function groundedMetadata(value: Record<string, unknown>): Pick<SkillOperation, "reason" | "evidence"> {
  return {
    reason: requiredString(value, "reason"),
    evidence: requiredEvidence(value),
  };
}

function parseOperation(value: unknown): SkillOperation {
  if (!isRecord(value)) throw new Error("Skill review operation must be an object.");
  const action = value.action;
  if (action === "create") {
    exactKeys(value, ["action", "name", "description", "content", "reason", "evidence"]);
    const content = requiredString(value, "content");
    if (content.length > MAX_SKILL_CONTENT_CHARS) throw new Error("Skill review content is too large.");
    return {
      action,
      name: requiredString(value, "name"),
      description: requiredString(value, "description"),
      content,
      ...groundedMetadata(value),
    };
  }
  if (action === "patch") {
    exactKeys(value, ["action", "name", "oldText", "newText", "reason", "evidence"]);
    return {
      action,
      name: requiredString(value, "name"),
      oldText: requiredString(value, "oldText"),
      newText: requiredString(value, "newText"),
      ...groundedMetadata(value),
    };
  }
  if (action === "archive") {
    exactKeys(value, ["action", "name", "reason", "evidence"]);
    return {
      action,
      name: requiredString(value, "name"),
      ...groundedMetadata(value),
    };
  }
  throw new Error("Skill review operation has an invalid action.");
}

export function parseSkillReviewPlan(raw: string): SkillReviewPlan {
  const parsed: unknown = JSON.parse(raw.trim());
  if (!isRecord(parsed)) throw new Error("Skill review JSON must contain an operations array.");
  exactKeys(parsed, ["operations"]);
  if (!Array.isArray(parsed.operations)) throw new Error("Skill review JSON must contain an operations array.");
  if (parsed.operations.length > 1) throw new Error("Skill review may return at most one operation.");
  return { operations: parsed.operations.map(parseOperation) };
}

function occurrences(text: string, search: string): number {
  return search ? text.split(search).length - 1 : 0;
}

function actionEvidenceReference(action: SkillAuthorshipPromptPacket["evidence"]["actions"][number]): string {
  return action.kind === "command"
    ? `ACTION command ${action.outcome}: ${action.command}`
    : `ACTION ${action.action} ${action.outcome}: ${action.path}`;
}

function exactEvidenceReference(value: string, packet: SkillAuthorshipPromptPacket): string {
  const canonical = validateSkillMetadataText(value);
  if (canonical !== value || canonical.length < 12) {
    throw new Error("Skill review evidence references must be canonical exact spans of at least 12 characters.");
  }
  if (packet.evidence.transcript.includes(canonical)) return canonical;
  if (packet.evidence.actions.some((action) => actionEvidenceReference(action) === canonical)) return canonical;
  throw new Error("Skill review evidence reference is not an exact transcript span or canonical action fact.");
}

/** Ground and canonicalize one model proposal against the exact bounded corpus shown to that model. */
export function validateSkillReviewPlanForPacket(
  plan: SkillReviewPlan,
  packet: SkillAuthorshipPromptPacket,
): SkillReviewPlan {
  const operations: SkillOperation[] = [];
  for (const operation of plan.operations) {
    const name = validateSkillName(operation.name);
    const reason = exactEvidenceReference(operation.reason || "", packet);
    const rawEvidence = operation.evidence || [];
    if (rawEvidence.length < 1 || rawEvidence.length > 8) {
      throw new Error("Skill review evidence must contain between 1 and 8 items.");
    }
    const evidence = rawEvidence.map((item) => exactEvidenceReference(item, packet));
    if (packet.corpus.pending.some((pending) => pending.action === operation.action && pending.name === name)) {
      throw new Error(`A ${operation.action} proposal for '${name}' is already pending.`);
    }
    const catalog = packet.corpus.catalog.find((skill) => skill.name === name);
    if (operation.action === "create") {
      if (catalog) throw new Error(`Project skill '${name}' already exists in the visible corpus.`);
      operations.push({
        action: "create",
        name,
        description: validateSkillDescription(operation.description || ""),
        content: validateGeneratedSkillContent(operation.content || ""),
        reason,
        evidence,
      });
      continue;
    }
    if (!catalog) throw new Error(`Project skill '${name}' is not visible in the bounded corpus.`);
    if (operation.action === "archive") {
      operations.push({ action: "archive", name, reason, evidence });
      continue;
    }
    const oldText = operation.oldText || "";
    const newText = operation.newText ?? "";
    if (!oldText || validateSkillContent(oldText) !== oldText) {
      throw new Error("Skill review patch requires an exact canonical oldText anchor.");
    }
    if (newText && validateSkillContent(newText) !== newText) {
      throw new Error("Skill review patch newText must already be canonical.");
    }
    const document = packet.corpus.documents.find((skill) => skill.name === name);
    if (catalog.bodyAvailable !== Boolean(document)) {
      throw new Error(`Project skill '${name}' has inconsistent bounded body availability.`);
    }
    const descriptionMatches = occurrences(catalog.description, oldText);
    const contentMatches = document ? occurrences(document.content, oldText) : 0;
    const matches = descriptionMatches + contentMatches;
    if (matches !== 1) {
      throw new Error(`Skill patch text is not visible exactly once in the bounded corpus (found ${matches}).`);
    }
    if (descriptionMatches === 1) {
      validateSkillDescription(catalog.description.replace(oldText, newText));
    } else {
      validateGeneratedSkillContent(document!.content.replace(oldText, newText));
    }
    operations.push({ action: "patch", name, oldText, newText, reason, evidence });
  }
  return { operations };
}
