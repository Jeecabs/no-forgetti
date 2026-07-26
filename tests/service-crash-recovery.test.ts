import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { memoryBranchDigest, ProjectMemoryStore } from "../src/store.ts";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const storeModule = pathToFileURL(join(repositoryRoot, "src/store.ts")).href;
const accountingModule = pathToFileURL(join(repositoryRoot, "src/service/accounting.ts")).href;
const daemonModule = pathToFileURL(join(repositoryRoot, "src/service/daemon.ts")).href;
const decisionsModule = pathToFileURL(join(repositoryRoot, "src/service/decisions.ts")).href;
const protocolModule = pathToFileURL(join(repositoryRoot, "src/service/protocol.ts")).href;
const engineModule = pathToFileURL(join(repositoryRoot, "src/service/review-engine.ts")).href;
const spoolModule = pathToFileURL(join(repositoryRoot, "src/service/spool.ts")).href;

const childSource = `
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileReviewAttemptAccounting } from ${JSON.stringify(accountingModule)};
import { ReviewDaemon } from ${JSON.stringify(daemonModule)};
import { ReviewDecisionStore } from ${JSON.stringify(decisionsModule)};
import { createReviewJob, createReviewOutcome } from ${JSON.stringify(protocolModule)};
import { ReviewEngine } from ${JSON.stringify(engineModule)};
import { ReviewSpool } from ${JSON.stringify(spoolModule)};
import { ProjectMemoryStore } from ${JSON.stringify(storeModule)};

const [command, ...args] = process.argv.slice(2);
const send = (value) => new Promise((resolve, reject) => {
  if (!process.send) return resolve(undefined);
  process.send(value, (error) => error ? reject(error) : resolve(undefined));
});
const decode = (value) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

const branch = {
  version: 1,
  name: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  entries: [{
    id: "entry-one",
    text: "Package commands use pnpm.",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    importance: "normal",
  }],
};
const provenance = {
  provider: "fault-provider",
  model: "fault-reviewer",
  api: "fault-api",
  responseModel: "fault-reviewer-2026-01",
  startedAt: "2026-01-03T00:00:00.000Z",
  completedAt: "2026-01-03T00:00:01.000Z",
  durationMs: 1000,
  usage: {
    input: 120,
    output: 30,
    cacheRead: 10,
    cacheWrite: 0,
    totalTokens: 160,
    cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 },
  },
};
const reviewJob = () => createReviewJob({
  projectKey: "a".repeat(24),
  sessionId: "private-session-id",
  throughEntryId: "assistant-9",
  transcript: "USER: Correction: always run pnpm check before finishing.",
  branch,
  maxChars: 4000,
});
const durableParts = (root) => ({
  spool: new ReviewSpool(root),
  accounting: new FileReviewAttemptAccounting(root, { now: () => new Date("2026-01-03T12:00:00.000Z") }),
  decisions: new ReviewDecisionStore(root),
});

if (command === "store-crash") {
  const [project, storage, phase, mode, encodedRequest] = args;
  const request = decode(encodedRequest);
  const store = new ProjectMemoryStore(project, {
    storageRoot: storage,
    now: () => new Date("2026-07-01T12:00:00.000Z"),
    admissionFailpoint: async (current) => {
      if (current !== phase) return;
      await send({ type: "fault-boundary", phase });
      if (mode === "exit") process.exit(86);
      await new Promise(() => {});
    },
  });
  await store.initialize();
  await store.applyReviewAdmission(request);
  throw new Error("admission unexpectedly crossed crash boundary");
} else if (command === "store-restart") {
  const [project, storage, encodedRequest] = args;
  const request = decode(encodedRequest);
  const store = new ProjectMemoryStore(project, {
    storageRoot: storage,
    now: () => new Date("2026-07-01T12:00:00.000Z"),
  });
  await store.initialize();
  const recovered = await store.getReviewAdmissionResult(request.transactionId);
  const retried = await store.applyReviewAdmission(request);
  const lookedUp = await store.getReviewAdmissionResult(request.transactionId);
  const loaded = await store.loadBranch(request.branchName);
  await send({ type: "result", recovered, retried, lookedUp, loaded });
} else if (command === "decision-crash") {
  const [root, marker] = args;
  const { spool, accounting, decisions } = durableParts(root);
  const job = reviewJob();
  await spool.enqueue(job);
  const runner = {
    async run(_request, hooks) {
      await appendFile(marker, "dispatch\\n", "utf8");
      await hooks?.beforeDispatch?.({
        provider: provenance.provider,
        model: provenance.model,
        api: provenance.api,
        requestDigest: "1".repeat(64),
        hold: { tokens: 400, costUsd: 0.5 },
      });
      await hooks?.observe?.(provenance);
      return { text: '{"operations":[]}', provenance };
    },
  };
  const daemon = new ReviewDaemon({
    spool,
    engine: new ReviewEngine(runner),
    budget: { maxCalls: 2, maxTokens: 1000, maxCostUsd: 1 },
    attemptAccounting: accounting,
    decisionStore: decisions,
    workerId: "fault-worker-1",
    leaseMs: 75,
    committer: {
      async commit() {
        await send({ type: "decision-durable", jobId: job.id });
        await new Promise(() => {});
      },
    },
  });
  await daemon.processOne();
  throw new Error("daemon unexpectedly crossed crash boundary");
} else if (command === "decision-restart") {
  const [root, marker] = args;
  const { spool, accounting, decisions } = durableParts(root);
  const runner = {
    async run() {
      await appendFile(marker, "rerun\\n", "utf8");
      throw new Error("durable decision must skip provider");
    },
  };
  const daemon = new ReviewDaemon({
    spool,
    engine: new ReviewEngine(runner),
    budget: { maxCalls: 2, maxTokens: 1000, maxCostUsd: 1 },
    attemptAccounting: accounting,
    decisionStore: decisions,
    workerId: "fault-worker-2",
    leaseMs: 1000,
  });
  const result = await daemon.processOne();
  const job = reviewJob();
  const outcome = await spool.getOutcome(job.id);
  const usage = await accounting.snapshot(provenance.provider);
  await send({ type: "result", result, outcome, usage });
} else if (command === "outcome-running-crash-image") {
  const [root] = args;
  const spool = new ReviewSpool(root);
  const job = reviewJob();
  await spool.enqueue(job);
  const claim = await spool.claim({ workerId: "outcome-worker-1", leaseMs: 60000 });
  if (!claim) throw new Error("expected claim");
  const runningPath = join(spool.runningDir, job.id + ".json");
  const runningRecord = await readFile(runningPath);
  const outcome = createReviewOutcome(job, {
    status: "completed",
    completedAt: provenance.completedAt,
    operations: [],
    provenance,
  });
  await spool.finish(claim, outcome);
  // Recreate exact image left after outcome publication but before running cleanup.
  await writeFile(runningPath, runningRecord, { mode: 0o600 });
  await send({
    type: "crash-image",
    running: await readdir(spool.runningDir),
    outcomes: await readdir(spool.outcomesDir),
  });
  process.exit(88);
} else if (command === "outcome-running-restart") {
  const [root] = args;
  const spool = new ReviewSpool(root);
  const first = await spool.recover();
  const second = await spool.recover();
  const job = reviewJob();
  const outcome = await spool.getOutcome(job.id);
  const claim = await spool.claim({ workerId: "outcome-worker-2", leaseMs: 1000 });
  await send({
    type: "result",
    first,
    second,
    outcome,
    claim: claim ?? null,
    running: await readdir(spool.runningDir),
    queued: await readdir(spool.queuedDir),
    outcomes: await readdir(spool.outcomesDir),
  });
} else {
  throw new Error("unknown child command: " + command);
}
`;

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

function startChild(script: string, args: string[]): {
  child: ChildProcess;
  exit: Promise<ChildExit>;
  message: (type: string) => Promise<Record<string, unknown>>;
} {
  const child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise<ChildExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
  return {
    child,
    exit,
    message(type: string) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for child message '${type}'. stderr: ${stderr}`));
        }, 8_000);
        const onMessage = (value: unknown) => {
          if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== type) return;
          cleanup();
          resolve(value as Record<string, unknown>);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanup();
          reject(new Error(`Child exited before '${type}' (${code ?? signal}). stderr: ${stderr}`));
        };
        const cleanup = () => {
          clearTimeout(timeout);
          child.off("message", onMessage);
          child.off("exit", onExit);
        };
        child.on("message", onMessage);
        child.on("exit", onExit);
      });
    },
  };
}

async function runToResult(script: string, args: string[]): Promise<Record<string, unknown>> {
  const process = startChild(script, args);
  const result = await process.message("result");
  const exited = await process.exit;
  assert.equal(exited.signal, null, exited.stderr);
  assert.equal(exited.code, 0, exited.stderr);
  return result;
}

async function ageDeadLock(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (!info) return;
  const stale = new Date(Date.now() - 60_000);
  await utimes(path, stale, stale);
}

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

test("real process deaths at every admission boundary converge to one stable commit", async (t) => {
  const cases = [
    { phase: "intent-written", mode: "SIGKILL" },
    { phase: "branch-written", mode: "exit" },
    { phase: "revision-written", mode: "SIGKILL" },
  ] as const;

  for (const fault of cases) {
    await t.test(`${fault.phase} via ${fault.mode}`, async (t) => {
      const base = await mkdtemp(join(tmpdir(), `no-forgetti-${fault.phase}-`));
      t.after(() => rm(base, { recursive: true, force: true }));
      const project = join(base, "repo");
      const storage = join(base, "state");
      await mkdir(project, { recursive: true });
      await writeFile(join(project, ".git"), "gitdir: elsewhere\n", "utf8");
      const store = new ProjectMemoryStore(project, {
        storageRoot: storage,
        now: () => new Date("2026-07-01T12:00:00.000Z"),
      });
      await store.initialize();
      const original = await store.applyOperation("main", { action: "add", content: "Original durable fact." });
      const entryId = original.branch.entries.at(0)!.id;
      const request = {
        transactionId: `fault_${fault.phase.replaceAll("-", "_")}`,
        branchName: "main",
        expectedBranchDigest: memoryBranchDigest(original.branch),
        operations: [{ action: "replace" as const, entryId, content: "Reviewed durable fact.", importance: "high" as const }],
      };
      const script = join(base, "fault-child.ts");
      await writeFile(script, childSource, "utf8");

      const crashed = startChild(script, [
        "store-crash",
        project,
        storage,
        fault.phase,
        fault.mode === "exit" ? "exit" : "hang",
        encoded(request),
      ]);
      await crashed.message("fault-boundary");
      if (fault.mode === "SIGKILL") assert.equal(crashed.child.kill("SIGKILL"), true);
      const death = await crashed.exit;
      if (fault.mode === "SIGKILL") {
        assert.equal(death.code, null, death.stderr);
        assert.equal(death.signal, "SIGKILL", death.stderr);
      } else {
        assert.equal(death.code, 86, death.stderr);
        assert.equal(death.signal, null, death.stderr);
      }

      // Crash leaves lock intentionally. Age it instead of adding a 30-second test delay.
      await ageDeadLock(join(store.projectDir, ".lock"));
      const restarted = await runToResult(script, ["store-restart", project, storage, encoded(request)]);
      assert.ok(restarted.recovered);
      assert.deepEqual(restarted.retried, restarted.recovered);
      assert.deepEqual(restarted.lookedUp, restarted.recovered);
      const result = restarted.recovered as {
        status: string;
        revisionId?: string;
        resultingBranchDigest: string;
        branch: { entries: Array<{ text: string }> };
      };
      assert.equal(result.status, "applied");
      assert.ok(result.revisionId);
      assert.deepEqual(result.branch.entries.map((entry) => entry.text), ["Reviewed durable fact."]);
      assert.deepEqual(
        (restarted.loaded as { entries: Array<{ text: string }> }).entries.map((entry) => entry.text),
        ["Reviewed durable fact."],
      );
      const revisions = await readdir(join(store.projectDir, "revisions", "main"));
      assert.equal(revisions.length, 1);
      const revision = JSON.parse(await readFile(join(store.projectDir, "revisions", "main", revisions[0]!), "utf8"));
      assert.equal(revision.id, result.revisionId);
    });
  }
});

test("restart consumes durable daemon decision without a second provider dispatch", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "no-forgetti-decision-crash-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "spool");
  const marker = join(base, "provider-calls.txt");
  const script = join(base, "fault-child.ts");
  await writeFile(script, childSource, "utf8");

  const crashed = startChild(script, ["decision-crash", root, marker]);
  await crashed.message("decision-durable");
  assert.equal(crashed.child.kill("SIGKILL"), true);
  const death = await crashed.exit;
  assert.equal(death.code, null, death.stderr);
  assert.equal(death.signal, "SIGKILL", death.stderr);
  await ageDeadLock(join(root, ".spool.lock"));
  await new Promise((resolve) => setTimeout(resolve, 125));

  const restarted = await runToResult(script, ["decision-restart", root, marker]);
  assert.equal((restarted.result as { status: string }).status, "completed");
  assert.equal((restarted.outcome as { status: string }).status, "completed");
  assert.equal(await readFile(marker, "utf8"), "dispatch\n");
  assert.deepEqual((restarted.usage as { charged: unknown }).charged, {
    calls: 1,
    tokens: 160,
    costNanodollars: 3_100_000,
  });
});

test("restart cleans fixed-point outcome plus running crash image", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "no-forgetti-outcome-running-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "spool");
  const script = join(base, "fault-child.ts");
  await writeFile(script, childSource, "utf8");

  const crashed = startChild(script, ["outcome-running-crash-image", root]);
  const image = await crashed.message("crash-image");
  assert.equal((image.running as string[]).length, 1);
  assert.equal((image.outcomes as string[]).length, 1);
  const death = await crashed.exit;
  assert.equal(death.code, 88, death.stderr);
  assert.equal(death.signal, null, death.stderr);

  const restarted = await runToResult(script, ["outcome-running-restart", root]);
  assert.deepEqual(restarted.first, { requeued: 0, quarantined: 0, cleaned: 1 });
  assert.deepEqual(restarted.second, { requeued: 0, quarantined: 0, cleaned: 0 });
  assert.equal((restarted.outcome as { status: string }).status, "completed");
  assert.equal(restarted.claim, null);
  assert.deepEqual(restarted.running, []);
  assert.deepEqual(restarted.queued, []);
  assert.equal((restarted.outcomes as string[]).length, 1);
});
