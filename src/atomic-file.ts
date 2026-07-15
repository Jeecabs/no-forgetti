import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
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
        const directory = await open(dirname(path), "r").catch(() => undefined);
        if (directory) {
          await directory.sync().catch(() => undefined);
          await directory.close().catch(() => undefined);
        }
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
