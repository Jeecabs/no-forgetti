import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EXTENSION_VERSION } from "../src/index.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

interface Manifest {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
  keywords?: string[];
  files?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
}

test("package manifest preserves No Forgetti identity and exposes extension plus service CLI", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Manifest;
  assert.equal(manifest.name, "no-forgetti");
  assert.equal(manifest.version, "0.4.1");
  // EXTENSION_VERSION is stamped into durable provenance records, so a version
  // bump that forgets src/index.ts must fail here rather than mislabel jobs.
  assert.equal(EXTENSION_VERSION, manifest.version);
  assert.deepEqual(manifest.bin, { "no-forgetti": "./bin/no-forgetti.mjs" });
  assert.ok(manifest.keywords?.includes("pi-package"));
  assert.deepEqual(manifest.pi?.extensions, ["./src/index.ts"]);
  assert.equal(manifest.dependencies?.["@earendil-works/pi-coding-agent"], "^0.82.1");
  assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).sort(), [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
  ]);
  assert.ok(manifest.files?.includes("src"));
  assert.ok(manifest.files?.includes("bin"));
  assert.ok(manifest.files?.includes("docs"));
  assert.ok(manifest.files?.includes("CONTEXT.md"));
  assert.ok(manifest.files?.includes("assets"));
  assert.ok(manifest.files?.includes("LICENSE"));
  assert.ok(!manifest.files?.some((path) => path.includes("test")));
});
