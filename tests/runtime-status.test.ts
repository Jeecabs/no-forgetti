import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readRuntimeFleet, RuntimeStatusReporter } from "../src/runtime-status.ts";

test("runtime fleet distinguishes current, stale, mismatched, and stopped processes", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "no-forgetti-runtimes-"));
  let clock = new Date("2026-03-01T12:00:00.000Z");
  const extension = new RuntimeStatusReporter({
    agentDir,
    identity: "extension:123:session-a",
    kind: "extension",
    pid: 123,
    releaseVersion: "0.4.0",
    memoryPolicyVersion: 2,
    projectRoot: "/projects/artificialanalysis",
    projectKey: "a".repeat(24),
    now: () => clock,
    heartbeatMs: 60_000,
  });
  const worker = new RuntimeStatusReporter({
    agentDir,
    identity: "worker:launchd",
    kind: "worker",
    pid: 456,
    releaseVersion: "0.3.0",
    memoryPolicyVersion: 1,
    now: () => clock,
    heartbeatMs: 60_000,
  });
  extension.start();
  worker.start();
  await Promise.all([extension.flush(), worker.flush()]);

  let fleet = await readRuntimeFleet(agentDir, { expectedReleaseVersion: "0.4.0", expectedMemoryPolicyVersion: 2, now: clock });
  assert.equal(fleet.current.length, 1);
  assert.equal(fleet.mismatched.length, 1);
  assert.equal(fleet.stale.length, 0);
  assert.equal((await stat(extension.path)).mode & 0o777, 0o600);

  clock = new Date("2026-03-01T12:00:31.000Z");
  fleet = await readRuntimeFleet(agentDir, { expectedReleaseVersion: "0.4.0", expectedMemoryPolicyVersion: 2, now: clock });
  assert.equal(fleet.stale.length, 2);

  extension.stop();
  await extension.flush();
  fleet = await readRuntimeFleet(agentDir, { expectedReleaseVersion: "0.4.0", expectedMemoryPolicyVersion: 2, now: clock });
  assert.equal(fleet.stopped.some((runtime) => runtime.pid === 123), true);
  worker.stop();
  await worker.flush();
});
