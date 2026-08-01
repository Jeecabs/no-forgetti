import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { sanitizeSkillEvidenceText } from "./skill-security.ts";
import { isRecord } from "./state-validation.ts";
import type { MemoryBranch, MemoryImportance } from "./types.ts";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_CONVENTION_CHARS = 8_000;
const MAX_MEMORY_CHARS = 6_000;
const MAX_SCRIPTS = 64;
const LOCKFILES = [
  "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb",
  "Cargo.lock", "go.mod", "uv.lock", "poetry.lock", "requirements.txt",
] as const;

export interface SkillConventionSnapshot {
  manifest?: {
    packageManager?: string;
    lockfiles: string[];
    scripts: Array<{ name: string; command: string }>;
  };
  memory: Array<{ importance: MemoryImportance; text: string }>;
}

async function regularFile(path: string): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > MAX_MANIFEST_BYTES) return undefined;
    const bytes = await handle.readFile();
    return bytes.byteLength <= MAX_MANIFEST_BYTES ? bytes : undefined;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT" || code === "ELOOP") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

function safeExactText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string" || !value || value.length > maxChars) return undefined;
  const sanitized = sanitizeSkillEvidenceText(value);
  return sanitized.redactionCount === 0 && sanitized.text === value ? value : undefined;
}

async function manifestSnapshot(projectRoot: string): Promise<SkillConventionSnapshot["manifest"]> {
  const bytes = await regularFile(join(projectRoot, "package.json"));
  let value: Record<string, unknown> | undefined;
  if (bytes) {
    try {
      const parsed: unknown = JSON.parse(bytes.toString("utf8")) as unknown;
      if (isRecord(parsed)) value = parsed;
    } catch {
      // A malformed package manifest contributes no facts; other lockfiles may still identify tooling.
    }
  }
  const packageManager = safeExactText(value?.packageManager, 100);
  const scripts = isRecord(value?.scripts)
    ? Object.entries(value.scripts)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([name, command]) => {
        if (!/^[A-Za-z0-9:_-]{1,100}$/u.test(name)) return [];
        const safe = safeExactText(command, 500);
        return safe ? [{ name, command: safe }] : [];
      })
      .slice(0, MAX_SCRIPTS)
    : [];
  const lockfiles: string[] = [];
  for (const name of LOCKFILES) if (await regularFile(join(projectRoot, name))) lockfiles.push(name);
  if (!value && lockfiles.length === 0) return undefined;
  const manifest = {
    ...(packageManager ? { packageManager } : {}),
    lockfiles,
    scripts,
  };
  return JSON.stringify(manifest, null, 2).length <= MAX_CONVENTION_CHARS ? manifest : undefined;
}

function memorySnapshot(branch?: MemoryBranch): SkillConventionSnapshot["memory"] {
  if (!branch) return [];
  const selected: SkillConventionSnapshot["memory"] = [];
  for (const entry of branch.entries) {
    const text = safeExactText(entry.text, 800);
    if (!text) continue;
    const candidate = [...selected, { importance: entry.importance, text }];
    if (JSON.stringify(candidate, null, 2).length > MAX_MEMORY_CHARS) break;
    selected.push({ importance: entry.importance, text });
  }
  return selected;
}

export async function buildSkillConventionSnapshot(request: {
  projectRoot: string;
  memory?: MemoryBranch;
}): Promise<SkillConventionSnapshot> {
  const manifest = await manifestSnapshot(request.projectRoot);
  return {
    ...(manifest ? { manifest } : {}),
    memory: memorySnapshot(request.memory),
  };
}
