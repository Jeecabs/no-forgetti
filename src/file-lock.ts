import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function processIsAlive(owner: string): boolean {
  const pid = Number(owner.split(":", 1)[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

async function removeDeadBreaker(path: string, staleMs: number): Promise<void> {
  const observed = await readFile(path, "utf8").catch(() => "");
  const info = await stat(path).catch(() => undefined);
  if (!info || Date.now() - info.mtimeMs <= staleMs || processIsAlive(observed)) return;
  const current = await readFile(path, "utf8").catch(() => "");
  if (current === observed) await unlink(path).catch(() => undefined);
}

async function reapDeadLock(lockPath: string, staleMs: number): Promise<void> {
  const breakerPath = `${lockPath}.breaker`;
  const breakerOwner = `${process.pid}:${randomUUID()}`;
  let breaker: Awaited<ReturnType<typeof open>> | undefined;
  try {
    breaker = await open(breakerPath, "wx", 0o600);
    await breaker.writeFile(breakerOwner, "utf8");
  } catch (error) {
    await breaker?.close().catch(() => undefined);
    if (!isErrno(error, "EEXIST")) throw error;
    await removeDeadBreaker(breakerPath, Math.min(staleMs, 1_000));
    return;
  }

  try {
    const observed = await readFile(lockPath, "utf8").catch(() => "");
    const info = await stat(lockPath).catch(() => undefined);
    if (!info || Date.now() - info.mtimeMs <= staleMs || processIsAlive(observed)) return;
    const current = await readFile(lockPath, "utf8").catch(() => "");
    if (current !== observed) return;
    const quarantine = `${lockPath}.stale.${randomUUID()}`;
    await rename(lockPath, quarantine).catch((error) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
    await unlink(quarantine).catch(() => undefined);
  } finally {
    await breaker.close().catch(() => undefined);
    const current = await readFile(breakerPath, "utf8").catch(() => "");
    if (current === breakerOwner) await unlink(breakerPath).catch(() => undefined);
  }
}

export async function withFileLock<T>(
  lockPath: string,
  timeoutMs: number,
  staleMs: number,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  const owner = `${process.pid}:${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${owner}\n${Date.now()}\n`, "utf8");
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if (!isErrno(error, "EEXIST")) throw error;
      await reapDeadLock(lockPath, staleMs);
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label} lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 25)));
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    const current = await readFile(lockPath, "utf8").catch(() => "");
    if (current.startsWith(`${owner}\n`)) await unlink(lockPath).catch(() => undefined);
  }
}
