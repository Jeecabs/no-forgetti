import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

interface Manifest {
  keywords?: string[];
  files?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
}

test("package manifest exposes only the extension runtime surface", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Manifest;
  assert.ok(manifest.keywords?.includes("pi-package"));
  assert.deepEqual(manifest.pi?.extensions, ["./src/index.ts"]);
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).sort(), [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
  ]);
  assert.ok(manifest.files?.includes("src"));
  assert.ok(manifest.files?.includes("assets"));
  assert.ok(manifest.files?.includes("LICENSE"));
  assert.ok(!manifest.files?.some((path) => path.includes("test")));
});
