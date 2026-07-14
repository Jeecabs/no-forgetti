import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function resolveProjectRoot(cwd: string): string {
  let current = canonicalPath(cwd);
  const filesystemRoot = parse(current).root;

  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    if (current === filesystemRoot) return canonicalPath(cwd);
    const parent = dirname(current);
    if (parent === current) return canonicalPath(cwd);
    current = parent;
  }
}

export function projectKey(projectRoot: string): string {
  return createHash("sha256").update(canonicalPath(projectRoot)).digest("hex").slice(0, 24);
}
