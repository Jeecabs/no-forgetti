import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r").catch(() => undefined);
  if (!directory) return;
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Publish an immutable file without ever exposing a partial final path. */
export async function atomicCreateFile(path: string, content: string): Promise<"created" | "duplicate"> {
  const directoryPath = dirname(path);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
      await unlink(temporary);
      await syncDirectory(directoryPath);
      return "created";
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const existing = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const actual = await existing.readFile({ encoding: "utf8" });
        if (actual !== content) throw new Error(`Conflicting immutable file already exists: ${path}`);
      } finally {
        await existing.close();
      }
      await unlink(temporary);
      await syncDirectory(directoryPath);
      return "duplicate";
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, path);
        await syncDirectory(dirname(path));
        return;
      } catch (error) {
        const transient = isErrno(error, "EPERM") || isErrno(error, "EBUSY") || isErrno(error, "EACCES");
        if (!transient || attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
