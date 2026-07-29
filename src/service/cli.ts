import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { formatDoctorReport, inspectNoForgettiInstallation, type DoctorOptions, type DoctorReport } from "../doctor.ts";
import { RuntimeStatusReporter } from "../runtime-status.ts";
import { MEMORY_POLICY_VERSION } from "../types.ts";
import { EXTENSION_VERSION } from "../version.ts";
import { FileReviewAttemptAccounting } from "./accounting.ts";
import { FileMemoryProposalCommitter } from "./admission.ts";
import { loadServiceConfig, type ReviewerProfile } from "./config.ts";
import {
  defaultReviewWorkerId,
  ReviewDaemon,
  type ReviewDaemonEvent,
  type ReviewDrainResult,
} from "./daemon.ts";
import { ReviewDecisionStore } from "./decisions.ts";
import { repairFailedReviewFeedback } from "./feedback-repair.ts";
import { PiModelRunner } from "./model-runner.ts";
import { ReviewWorkerStatusReporter } from "./monitor.ts";
import { ReviewEngine } from "./review-engine.ts";
import { ReviewSpool } from "./spool.ts";

export const REVIEW_CLI_USAGE = `Usage: no-forgetti review [--once] [options]

Options:
  --once                 Drain currently queued reviews, then exit.
  --agent-dir <path>     Pi agent directory (default: PI_CODING_AGENT_DIR or ~/.pi/agent).
  --worker-id <id>       Stable spool worker identifier.
  --lease-ms <number>    Durable claim lease duration.
  --poll-ms <number>     Idle daemon polling interval.
  --max-attempts <count> Terminal retry limit for non-configuration failures.
  -h, --help             Show this help.
`;

export const DOCTOR_CLI_USAGE = `Usage: no-forgetti doctor [options]

Options:
  --json                  Emit a machine-readable report.
  --agent-dir <path>      Pi agent directory (default: PI_CODING_AGENT_DIR or ~/.pi/agent).
  --projects-root <path>  Scan Git roots below this directory for local overrides.
  -h, --help              Show this help.
`;

export const CLI_USAGE = `${REVIEW_CLI_USAGE}\n${DOCTOR_CLI_USAGE}`;

export interface ReviewCliArgs {
  command: "review";
  once: boolean;
  help: boolean;
  agentDir?: string;
  workerId?: string;
  leaseMs?: number;
  pollMs?: number;
  maxAttempts?: number;
}

export interface DoctorCliArgs {
  command: "doctor";
  help: boolean;
  json: boolean;
  agentDir?: string;
  projectsRoot?: string;
}

export type CliArgs = ReviewCliArgs | DoctorCliArgs;

export interface ReviewCliDaemon {
  drain(signal?: AbortSignal): Promise<ReviewDrainResult>;
  run(signal?: AbortSignal): Promise<void>;
  stop(): void;
}

export interface ReviewCliRuntime {
  daemon: ReviewCliDaemon;
  dispose(): void | Promise<void>;
}

export interface ReviewCliDependencies {
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  createRuntime?: (args: ReviewCliArgs, onEvent: (event: ReviewDaemonEvent) => void) => Promise<ReviewCliRuntime>;
  inspectInstallation?: (options: DoctorOptions) => Promise<DoctorReport>;
  packageRoot?: string;
}

function optionValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value.`);
  return value;
}

function positiveInteger(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${flag} requires a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} is too large.`);
  return parsed;
}

export function parseReviewCliArgs(argv: readonly string[]): ReviewCliArgs {
  if (argv.length === 0 || argv.at(0) !== "review") throw new Error("Expected 'review' command.");
  const parsed: ReviewCliArgs = { command: "review", once: false, help: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--once") parsed.once = true;
    else if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "--agent-dir") parsed.agentDir = optionValue(argv, index++, arg);
    else if (arg === "--worker-id") parsed.workerId = optionValue(argv, index++, arg);
    else if (arg === "--lease-ms") parsed.leaseMs = positiveInteger(optionValue(argv, index++, arg), arg);
    else if (arg === "--poll-ms") parsed.pollMs = positiveInteger(optionValue(argv, index++, arg), arg);
    else if (arg === "--max-attempts") parsed.maxAttempts = positiveInteger(optionValue(argv, index++, arg), arg);
    else throw new Error(`Unknown review option: ${arg}`);
  }
  if (parsed.workerId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(parsed.workerId)) {
    throw new Error("--worker-id contains unsupported characters.");
  }
  return parsed;
}

function parseDoctorCliArgs(argv: readonly string[]): DoctorCliArgs {
  if (argv.at(0) !== "doctor") throw new Error("Expected 'doctor' command.");
  const parsed: DoctorCliArgs = { command: "doctor", help: false, json: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--json") parsed.json = true;
    else if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "--agent-dir") parsed.agentDir = optionValue(argv, index++, arg);
    else if (arg === "--projects-root") parsed.projectsRoot = optionValue(argv, index++, arg);
    else throw new Error(`Unknown doctor option: ${arg}`);
  }
  return parsed;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  if (argv.at(0) === "review") return parseReviewCliArgs(argv);
  if (argv.at(0) === "doctor") return parseDoctorCliArgs(argv);
  throw new Error("Expected 'review' or 'doctor' command.");
}

function publicEvent(event: ReviewDaemonEvent): unknown {
  if (event.type === "retry" || event.type === "failed") {
    return {
      type: event.type,
      jobId: event.jobId,
      attempt: event.attempt,
      failure: { code: event.failure.code, retryable: event.failure.retryable },
    };
  }
  return event;
}

function reviewerBudget(profile: ReviewerProfile) {
  return {
    maxCalls: Math.floor(profile.maxCallsPerDay),
    maxTokens: Math.floor(profile.maxTokensPerDay),
    maxCostUsd: profile.maxCostPerDayUsd,
  };
}

async function createDefaultRuntime(
  args: ReviewCliArgs,
  onEvent: (event: ReviewDaemonEvent) => void,
): Promise<ReviewCliRuntime> {
  const agentDir = resolve(args.agentDir ?? getAgentDir());
  const config = await loadServiceConfig(agentDir);
  if (!config.reviewer) {
    throw new Error("Review service requires reviewer configuration in no-forgetti/service.json.");
  }
  const serviceRoot = join(agentDir, "no-forgetti");
  const { SQLiteReviewLedger } = await import("./ledger.ts");
  const ledger = new SQLiteReviewLedger(join(serviceRoot, "review-ledger.sqlite"));
  const spool = new ReviewSpool(join(serviceRoot, "review-spool"), { ledger });
  const attemptAccounting = new FileReviewAttemptAccounting(spool.root);
  const decisionStore = new ReviewDecisionStore(spool.root);
  const committer = config.mode === "external" ? new FileMemoryProposalCommitter(agentDir) : undefined;
  await Promise.all([spool.initialize(), attemptAccounting.initialize()]);
  await spool.recover();
  const repairFeedback = async () => {
    if (!committer) return;
    await repairFailedReviewFeedback({ spool, decisions: decisionStore, committer });
  };
  await repairFeedback();
  const importLegacyBudget = async (): Promise<void> => {
    if (!attemptAccounting.importLegacyDailyBudget) return;
    try {
      const encoded = await readFile(join(serviceRoot, "review-budget.json"), "utf8");
      if (Buffer.byteLength(encoded, "utf8") > 4_096) throw new Error("Legacy review budget record is oversized.");
      await attemptAccounting.importLegacyDailyBudget(config.reviewer!.provider, JSON.parse(encoded));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    }
  };
  await importLegacyBudget();
  const reconcileAttempts = async (): Promise<void> => {
    if (!attemptAccounting.listRecoveryCandidates || !attemptAccounting.reconcileRecovery) return;
    const liveLeaseTokens = (await spool.activeClaims()).map((claim) => claim.leaseToken);
    let cursor: string | undefined;
    do {
      const page = await attemptAccounting.listRecoveryCandidates({ limit: 1_000, ...(cursor ? { cursor } : {}) });
      const results = [];
      for (const candidate of page.candidates) {
        const jobId = candidate.claim.jobId;
        if (!jobId) continue;
        const checkpoint = await decisionStore.loadAttempt(jobId, candidate.reservation.id);
        const provenance = checkpoint?.outcome.provenance;
        if (provenance) results.push({
          reservation: candidate.reservation,
          provenance,
          ...(candidate.dispatch ? { dispatch: candidate.dispatch } : {}),
        });
      }
      await attemptAccounting.reconcileRecovery({
        candidates: page.candidates.map((candidate) => candidate.reservation),
        liveLeaseTokens,
        results,
        expiresBefore: new Date().toISOString(),
      });
      cursor = page.nextCursor;
    } while (cursor);
  };
  await reconcileAttempts();
  const retentionMs = config.evidenceTtlHours * 60 * 60_000;
  const activeJobIds = async (): Promise<Set<string>> => {
    const names = (await Promise.all([spool.queuedDir, spool.runningDir].map(async (dir) => {
      try {
        return await readdir(dir);
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    }))).flat();
    return new Set(names
      .filter((name) => /^review_[0-9a-f]{40}\.json$/u.test(name))
      .map((name) => name.slice(0, -5)));
  };
  const purgeExpired = async () => {
    // Retention changes take effect without restarting a long-lived worker.
    const currentConfig = await loadServiceConfig(agentDir);
    const currentRetentionMs = currentConfig.evidenceTtlHours * 60 * 60_000;
    const retentionCutoff = new Date(Date.now() - currentRetentionMs);
    await spool.recover();
    await importLegacyBudget();
    await reconcileAttempts();
    const protectedJobs = await activeJobIds();
    await decisionStore.purgeTerminalBefore(retentionCutoff, protectedJobs);
    await spool.purgeTerminalBefore(retentionCutoff);
    await attemptAccounting.purgeClosedDaysBefore(retentionCutoff);
    ledger.purgeTerminalBefore(retentionCutoff);
  };
  await purgeExpired();
  const engine = new ReviewEngine(new PiModelRunner(config.reviewer, { agentDir }));
  const workerId = args.workerId ?? defaultReviewWorkerId();
  const reporter = new ReviewWorkerStatusReporter(agentDir, workerId);
  const runtimeReporter = new RuntimeStatusReporter({
    agentDir,
    identity: `worker:${workerId}`,
    kind: "worker",
    releaseVersion: EXTENSION_VERSION,
    memoryPolicyVersion: MEMORY_POLICY_VERSION,
  });
  const daemon = new ReviewDaemon({
    spool,
    engine,
    budget: reviewerBudget(config.reviewer),
    attemptAccounting,
    decisionStore,
    ledger,
    workerId,
    ...(args.leaseMs ? { leaseMs: args.leaseMs } : {}),
    ...(args.pollMs ? { pollMs: args.pollMs } : {}),
    ...(args.maxAttempts ? { maxAttempts: args.maxAttempts } : {}),
    onEvent: (event) => {
      reporter.record(event);
      onEvent(event);
    },
    maintenance: purgeExpired,
    maintenanceIntervalMs: Math.max(60_000, Math.min(60 * 60_000, Math.floor(retentionMs / 4))),
    ...(committer ? { committer } : {}),
  });
  reporter.start();
  runtimeReporter.start();
  const heartbeat = setInterval(() => reporter.heartbeat(), 10_000);
  heartbeat.unref?.();
  let feedbackRepairPending = Promise.resolve();
  const feedbackRepairTimer = setInterval(() => {
    feedbackRepairPending = feedbackRepairPending
      .catch(() => undefined)
      .then(repairFeedback);
  }, 60_000);
  feedbackRepairTimer.unref?.();
  return {
    daemon,
    async dispose() {
      clearInterval(heartbeat);
      clearInterval(feedbackRepairTimer);
      reporter.stop();
      runtimeReporter.stop();
      await Promise.all([reporter.flush(), runtimeReporter.flush(), feedbackRepairPending.catch(() => undefined)]);
      ledger.close();
    },
  };
}

type CliWriter = Pick<NodeJS.WriteStream, "write">;

async function runDoctorCommand(
  args: DoctorCliArgs,
  dependencies: ReviewCliDependencies,
  stdout: CliWriter,
  stderr: CliWriter,
): Promise<number> {
  try {
    const agentDir = resolve(args.agentDir ?? getAgentDir());
    const report = await (dependencies.inspectInstallation ?? inspectNoForgettiInstallation)({
      agentDir,
      packageRoot: resolve(dependencies.packageRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..")),
      ...(args.projectsRoot ? { projectsRoot: resolve(args.projectsRoot) } : {}),
      expectedReleaseVersion: EXTENSION_VERSION,
      expectedMemoryPolicyVersion: MEMORY_POLICY_VERSION,
    });
    stdout.write(`${args.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report)}\n`);
    return report.healthy ? 0 : 1;
  } catch (error) {
    stderr.write(`No Forgetti doctor failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runReviewCommand(
  args: ReviewCliArgs,
  dependencies: ReviewCliDependencies,
  stdout: CliWriter,
  stderr: CliWriter,
): Promise<number> {
  const onEvent = (event: ReviewDaemonEvent) => stdout.write(`${JSON.stringify(publicEvent(event))}\n`);
  let runtime: ReviewCliRuntime | undefined;
  const controller = new AbortController();
  const shutdown = () => {
    controller.abort();
    runtime?.daemon.stop();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    runtime = await (dependencies.createRuntime ?? createDefaultRuntime)(args, onEvent);
    if (args.once) {
      const result = await runtime.daemon.drain(controller.signal);
      stdout.write(`${JSON.stringify({ type: "drained", ...result })}\n`);
      return result.interrupted ? 130 : 0;
    }
    await runtime.daemon.run(controller.signal);
    return controller.signal.aborted ? 0 : 1;
  } catch (error) {
    stderr.write(`Review service failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    await runtime?.dispose();
  }
}

export async function runServiceCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: ReviewCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let parsed: CliArgs;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n${CLI_USAGE}`);
    return 2;
  }
  if (parsed.help) {
    stdout.write(parsed.command === "doctor" ? DOCTOR_CLI_USAGE : REVIEW_CLI_USAGE);
    return 0;
  }
  return parsed.command === "doctor"
    ? runDoctorCommand(parsed, dependencies, stdout, stderr)
    : runReviewCommand(parsed, dependencies, stdout, stderr);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  process.exitCode = await runServiceCli();
}
