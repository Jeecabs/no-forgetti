import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { syncDirectoryStrict } from "../atomic-file.ts";
import { isErrno, isRecord } from "../state-validation.ts";

export const DEFAULT_ADMISSION_ARTIFACT_BYTES = 256 * 1024;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Admission JSON contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) throw new Error("Admission JSON contains undefined.");
      return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
    }).join(",")}}`;
  }
  throw new Error(`Admission value is not JSON (${typeof value}).`);
}

/** SHA-256 over canonical JSON with recursively sorted object keys. */
export function admissionJsonDigest(value: JsonValue | object): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const directoryOnly = "O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0;
  const directory = await open(path, constants.O_RDONLY | noFollow | directoryOnly);
  try {
    if (!(await directory.stat()).isDirectory()) throw new Error(`Admission state path is not a directory: ${path}`);
    await directory.chmod(0o700);
  } finally {
    await directory.close();
  }
}

async function readBoundedPrivateJson(path: string, maxBytes: number): Promise<unknown> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const file = await open(path, constants.O_RDONLY | noFollow);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`Admission publication is not a regular file: ${path}`);
    if ((info.mode & 0o777) !== 0o600) throw new Error(`Admission publication must be a private 0600 file: ${path}`);
    if (info.size <= 0 || info.size > maxBytes) throw new Error(`Admission publication exceeds ${maxBytes} bytes or is empty: ${path}`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) throw new Error(`Admission publication exceeds ${maxBytes} bytes: ${path}`);
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`Admission publication exceeds ${maxBytes} bytes: ${path}`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
  } finally {
    await file.close();
  }
}

/** Atomically creates a private JSON artifact, or proves the existing artifact is exactly equal. */
export async function createOrCompareJsonFile(
  path: string,
  value: JsonValue | object,
  maxBytes = DEFAULT_ADMISSION_ARTIFACT_BYTES,
): Promise<"created" | "matching"> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Admission publication byte limit must be positive.");
  const canonical = canonicalJson(value);
  const content = `${canonical}\n`;
  if (Buffer.byteLength(content, "utf8") > maxBytes) throw new Error(`Admission publication exceeds ${maxBytes} bytes.`);
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  let temporaryExists = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    temporaryExists = true;
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
      await unlink(temporary);
      temporaryExists = false;
      await syncDirectoryStrict(parent);
      return "created";
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const existing = await readBoundedPrivateJson(path, maxBytes);
      if (canonicalJson(existing) !== canonical) throw new Error(`Conflicting publication already exists at ${path}.`);
      return "matching";
    }
  } finally {
    if (temporaryExists) await unlink(temporary).catch(() => undefined);
  }
}
