import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SERVICE_CONFIG_VERSION = 1;
export const MAX_SERVICE_CONFIG_BYTES = 64 * 1024;

export type ReviewAuthorityMode = "embedded" | "shadow" | "external";

export interface ReviewerProfile {
  provider: string;
  model: string;
  reasoningEffort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  maxCallsPerDay: number;
  maxTokensPerDay: number;
  maxCostPerDayUsd: number;
}

export interface ServiceConfig {
  version: number;
  mode: ReviewAuthorityMode;
  evidenceTtlHours: number;
  reviewer?: ReviewerProfile;
}

export const DEFAULT_SERVICE_CONFIG: ServiceConfig = {
  version: SERVICE_CONFIG_VERSION,
  mode: "embedded",
  evidenceTtlHours: 24,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`Invalid ${label} fields: ${extras.join(", ")}.`);
}

function positiveNumber(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string, max: number): number {
  const parsed = positiveNumber(value, label, max);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${label}.`);
  return parsed;
}

function parseReviewer(value: unknown): ReviewerProfile | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid No Forgetti reviewer profile.");
  exactKeys(value, [
    "provider", "model", "reasoningEffort", "maxCallsPerDay", "maxTokensPerDay", "maxCostPerDayUsd",
  ], "No Forgetti reviewer profile");
  if (typeof value.provider !== "string" || !value.provider.trim() || typeof value.model !== "string" || !value.model.trim()) {
    throw new Error("Invalid No Forgetti reviewer profile.");
  }
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
  const reasoningEffort = value.reasoningEffort === undefined
    ? "medium"
    : levels.includes(value.reasoningEffort as typeof levels[number])
      ? value.reasoningEffort as ReviewerProfile["reasoningEffort"]
      : undefined;
  if (!reasoningEffort) throw new Error("Invalid reviewer reasoning effort.");
  return {
    provider: value.provider,
    model: value.model,
    reasoningEffort,
    maxCallsPerDay: positiveInteger(value.maxCallsPerDay ?? 100, "reviewer call budget", 10_000),
    maxTokensPerDay: positiveInteger(value.maxTokensPerDay ?? 500_000, "reviewer token budget", 1_000_000_000),
    maxCostPerDayUsd: positiveNumber(value.maxCostPerDayUsd ?? 10, "reviewer cost budget", 1_000_000),
  };
}

export function parseServiceConfig(value: unknown): ServiceConfig {
  if (!isRecord(value) || value.version !== SERVICE_CONFIG_VERSION) {
    throw new Error("Unsupported or invalid No Forgetti service config.");
  }
  exactKeys(value, ["version", "mode", "evidenceTtlHours", "reviewer"], "No Forgetti service config");
  if (value.mode !== "embedded" && value.mode !== "shadow" && value.mode !== "external") {
    throw new Error("Invalid No Forgetti review authority mode.");
  }
  const reviewer = parseReviewer(value.reviewer);
  if (value.mode === "external" && !reviewer) throw new Error("External review mode requires a reviewer profile.");
  return {
    version: SERVICE_CONFIG_VERSION,
    mode: value.mode,
    evidenceTtlHours: positiveNumber(value.evidenceTtlHours ?? 24, "evidence TTL", 24 * 365),
    ...(reviewer ? { reviewer } : {}),
  };
}

export function serviceConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, "no-forgetti", "service.json");
}

export async function loadServiceConfig(agentDir = getAgentDir()): Promise<ServiceConfig> {
  const path = serviceConfigPath(agentDir);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0) throw new Error("No Forgetti service config must be a non-empty regular file.");
    if (info.size > MAX_SERVICE_CONFIG_BYTES) throw new Error(`No Forgetti service config exceeds ${MAX_SERVICE_CONFIG_BYTES} bytes.`);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_SERVICE_CONFIG_BYTES) {
      throw new Error(`No Forgetti service config exceeds ${MAX_SERVICE_CONFIG_BYTES} bytes.`);
    }
    return parseServiceConfig(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_SERVICE_CONFIG;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
