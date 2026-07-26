import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isErrno } from "./state-validation.ts";

/** Parent-directory fsync that fails loudly, for callers whose durability depends on it. */
export async function syncDirectoryStrict(path: string): Promise<void> {
  const directory = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0),
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Unlink whose removal is durable before it reports success. */
export async function durableUnlink(path: string): Promise<boolean> {
  try {
    await unlink(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
  await syncDirectoryStrict(dirname(path));
  return true;
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
      await syncDirectoryStrict(directoryPath);
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
      await syncDirectoryStrict(directoryPath);
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
        break;
      } catch (error) {
        const transient = isErrno(error, "EPERM") || isErrno(error, "EBUSY") || isErrno(error, "EACCES");
        if (!transient || attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
    // Sync outside the loop: the rename already succeeded, so an fsync failure
    // must surface rather than trigger a rename retry that would now ENOENT.
    await syncDirectoryStrict(dirname(path));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
