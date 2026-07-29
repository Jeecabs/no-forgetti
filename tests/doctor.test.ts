import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectNoForgettiInstallation } from "../src/doctor.ts";
import { parseCliArgs } from "../src/service/cli.ts";
import { RuntimeStatusReporter } from "../src/runtime-status.ts";
import type { ReviewServiceMonitor } from "../src/service/monitor.ts";

const version = "0.4.0";
const observedAt = "2026-03-01T12:00:00.000Z";

function monitor(): ReviewServiceMonitor {
  return {
    mode: "external",
    budget: { day: "2026-03-01", calls: 0, tokens: 0, costUsd: 0 },
    spool: { queued: 0, running: 0, outcomes: 0, deadLetter: 0 },
    worker: {
      version: 1,
      workerId: "launchd",
      pid: 456,
      startedAt: observedAt,
      updatedAt: observedAt,
      state: "idle",
      memoryPolicyVersion: 2,
      maxMemoryChars: 6_000,
    },
    workerFresh: true,
    workerCompatible: true,
    exhausted: [],
    observedAt,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "no-forgetti-doctor-"));
  const agentDir = join(root, "agent");
  const packageRoot = join(root, "package");
  const projectsRoot = join(root, "projects");
  const project = join(projectsRoot, "artificialanalysis");
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(packageRoot, { recursive: true }),
    mkdir(join(project, ".git"), { recursive: true }),
    mkdir(join(project, ".pi"), { recursive: true }),
  ]);
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "no-forgetti", version }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    packages: [`https://github.com/Jeecabs/no-forgetti@v${version}`],
  }));
  await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ packages: [] }));

  const extension = new RuntimeStatusReporter({
    agentDir,
    identity: "extension:123:session",
    kind: "extension",
    pid: 123,
    releaseVersion: version,
    memoryPolicyVersion: 2,
    projectRoot: project,
    projectKey: "a".repeat(24),
    now: () => new Date(observedAt),
    heartbeatMs: 60_000,
  });
  const worker = new RuntimeStatusReporter({
    agentDir,
    identity: "worker:launchd",
    kind: "worker",
    pid: 456,
    releaseVersion: version,
    memoryPolicyVersion: 2,
    now: () => new Date(observedAt),
    heartbeatMs: 60_000,
  });
  extension.start();
  worker.start();
  await Promise.all([extension.flush(), worker.flush()]);
  return { agentDir, packageRoot, project, projectsRoot, extension, worker };
}

test("doctor CLI accepts machine-readable project-root verification", () => {
  assert.deepEqual(parseCliArgs([
    "doctor",
    "--json",
    "--agent-dir",
    "/tmp/agent",
    "--projects-root",
    "/tmp/projects",
  ]), {
    command: "doctor",
    help: false,
    json: true,
    agentDir: "/tmp/agent",
    projectsRoot: "/tmp/projects",
  });
});

test("doctor accepts one pinned global install with current live extension and worker runtimes", async () => {
  const state = await fixture();
  const report = await inspectNoForgettiInstallation({
    agentDir: state.agentDir,
    packageRoot: state.packageRoot,
    projectsRoot: state.projectsRoot,
    expectedReleaseVersion: version,
    expectedMemoryPolicyVersion: 2,
    now: new Date(observedAt),
    loadMonitor: async () => monitor(),
    listPiProcesses: async () => [{ pid: 123, cwd: state.project }],
  });

  assert.equal(report.healthy, true);
  assert.equal(report.projects.scanned, 1);
  assert.deepEqual(report.projects.overrides, []);
  assert.deepEqual(report.runtimes.unverifiedPiProcesses, []);
  assert.equal(report.checks.every((check) => check.status !== "error"), true);
  state.extension.stop();
  state.worker.stop();
});

test("doctor fails closed on a project override or unverified live Pi runtime", async () => {
  const state = await fixture();
  await writeFile(join(state.project, ".pi", "settings.json"), JSON.stringify({
    packages: ["https://github.com/Jeecabs/no-forgetti@main"],
  }));
  const report = await inspectNoForgettiInstallation({
    agentDir: state.agentDir,
    packageRoot: state.packageRoot,
    projectsRoot: state.projectsRoot,
    expectedReleaseVersion: version,
    expectedMemoryPolicyVersion: 2,
    now: new Date(observedAt),
    loadMonitor: async () => monitor(),
    listPiProcesses: async () => [{ pid: 123, cwd: state.project }, { pid: 999, cwd: "/projects/stale" }],
  });

  assert.equal(report.healthy, false);
  assert.deepEqual(report.projects.overrides, [state.project]);
  assert.deepEqual(report.runtimes.unverifiedPiProcesses, [{ pid: 999, cwd: "/projects/stale" }]);
  state.extension.stop();
  state.worker.stop();
});
