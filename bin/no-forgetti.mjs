#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = resolve(root, "src/service/cli.ts");
const child = spawn(process.execPath, [
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
  entry,
  ...process.argv.slice(2),
], {
  stdio: "inherit",
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  process.stderr.write(`Failed to start No Forgetti: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 128 : 1);
});
