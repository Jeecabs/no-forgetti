import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { FileMemoryProposalCommitter } from "./admission.ts";
import { loadServiceConfig, type ReviewerProfile } from "./config.ts";
import {
  defaultReviewWorkerId,
  FileReviewBudgetAccount,
  ReviewDaemon,
  type ReviewDaemonEvent,
  type ReviewDrainResult,
} from "./daemon.ts";
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
  if (argv.length === 0 || argv[0] !== "review") throw new Error("Expected 'review' command.");
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
  await spool.initialize();
  await spool.recover();
  const retentionMs = config.evidenceTtlHours * 60 * 60_000;
  const purgeExpired = async () => {
    const retentionCutoff = new Date(Date.now() - retentionMs);
    await spool.purgeTerminalBefore(retentionCutoff);
    ledger.purgeTerminalBefore(retentionCutoff);
  };
  await purgeExpired();
  const engine = new ReviewEngine(new PiModelRunner(config.reviewer, { agentDir }));
  const workerId = args.workerId ?? defaultReviewWorkerId();
  const reporter = new ReviewWorkerStatusReporter(agentDir, workerId);
  reporter.start();
  const daemon = new ReviewDaemon({
    spool,
    engine,
    budget: reviewerBudget(config.reviewer),
    budgetAccount: new FileReviewBudgetAccount(join(serviceRoot, "review-budget.json")),
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
    ...(config.mode === "external" ? { committer: new FileMemoryProposalCommitter(agentDir) } : {}),
  });
  return {
    daemon,
    async dispose() {
      reporter.stop();
      await reporter.flush();
      ledger.close();
    },
  };
}

export async function runServiceCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: ReviewCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let args: ReviewCliArgs;
  try {
    args = parseReviewCliArgs(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n${REVIEW_CLI_USAGE}`);
    return 2;
  }
  if (args.help) {
    stdout.write(REVIEW_CLI_USAGE);
    return 0;
  }

  const onEvent = (event: ReviewDaemonEvent) => {
    stdout.write(`${JSON.stringify(publicEvent(event))}\n`);
  };
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

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  process.exitCode = await runServiceCli();
}
