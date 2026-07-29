import {
  ReviewFeedbackInbox,
  type PendingReviewFeedback,
  type ReviewRequestOrigin,
} from "./feedback.ts";
import { ReviewSpool, type ReviewSpoolActivity } from "./spool.ts";

export type ProjectReviewPhase = "queued" | "reviewing" | "retrying" | "paused" | "finishing";
export type ProjectReviewPauseReason = "offline" | "budget" | "update";

export interface ProjectReviewActivity {
  jobId: string;
  phase: ProjectReviewPhase;
  attempt: number;
  branchName?: string;
  requestedBy?: ReviewRequestOrigin;
  queuedAt?: string;
  startedAt?: string;
  retryAt?: string;
  pauseReason?: ProjectReviewPauseReason;
  outcomeStatus?: "completed" | "failed";
}

export interface ProjectReviewActivitySnapshot {
  observedAt: string;
  jobs: ProjectReviewActivity[];
}

export interface ProjectReviewActivityReaderOptions {
  inbox: ReviewFeedbackInbox;
  spool: ReviewSpool;
  now?: () => Date;
}

export interface ProjectReviewServiceState {
  workerFresh: boolean;
  workerCompatible?: boolean;
  exhausted: readonly unknown[];
}

const PHASE_PRIORITY: Record<ProjectReviewPhase, number> = {
  reviewing: 0,
  finishing: 1,
  retrying: 2,
  queued: 3,
  paused: 4,
};

function pauseReason(monitor: ProjectReviewServiceState): ProjectReviewPauseReason | undefined {
  if (monitor.workerCompatible === false) return "update";
  if (monitor.exhausted.length > 0) return "budget";
  if (!monitor.workerFresh) return "offline";
  return undefined;
}

function commonActivity(pending: PendingReviewFeedback) {
  return {
    jobId: pending.jobId,
    ...(pending.branchName ? { branchName: pending.branchName } : {}),
    ...(pending.requestedBy ? { requestedBy: pending.requestedBy } : {}),
    ...(pending.queuedAt ? { queuedAt: pending.queuedAt } : {}),
  };
}

function projectActivity(
  pending: PendingReviewFeedback,
  spool: ReviewSpoolActivity,
  paused: ProjectReviewPauseReason | undefined,
): ProjectReviewActivity {
  const common = commonActivity(pending);
  if (spool.state === "completed") {
    return {
      ...common,
      phase: "finishing",
      attempt: spool.attempt,
      outcomeStatus: spool.outcomeStatus,
    };
  }

  const projected = spool.state === "running"
    ? { ...common, phase: "reviewing" as const, attempt: spool.attempt, startedAt: spool.claimedAt }
    : spool.state === "queued" && spool.attempt > 1
      ? {
        ...common,
        phase: "retrying" as const,
        attempt: spool.attempt,
        ...(spool.availableAt ? { retryAt: spool.availableAt } : {}),
      }
      : { ...common, phase: "queued" as const, attempt: spool.state === "queued" ? spool.attempt : 1 };
  return paused ? { ...projected, phase: "paused", pauseReason: paused } : projected;
}

/** Joins project-local delivery interest with the durable global spool. */
export class ProjectReviewActivityReader {
  private readonly inbox: ReviewFeedbackInbox;
  private readonly spool: ReviewSpool;
  private readonly clock: () => Date;

  constructor(options: ProjectReviewActivityReaderOptions) {
    this.inbox = options.inbox;
    this.spool = options.spool;
    this.clock = options.now ?? (() => new Date());
  }

  async snapshot(monitor: ProjectReviewServiceState): Promise<ProjectReviewActivitySnapshot> {
    const observedAt = this.clock();
    if (!Number.isFinite(observedAt.getTime())) throw new Error("Invalid project review activity clock.");
    const pending = (await this.inbox.listPending()).sort((left, right) =>
      (left.queuedAt ?? "").localeCompare(right.queuedAt ?? "") || left.jobId.localeCompare(right.jobId));
    const spool = await this.spool.inspect(pending.map((record) => record.jobId));
    const spoolByJob = new Map(spool.map((record) => [record.jobId, record]));
    const paused = pauseReason(monitor);
    const jobs = pending.map((record) => projectActivity(
      record,
      spoolByJob.get(record.jobId) ?? { jobId: record.jobId, state: "missing" },
      paused,
    ));
    jobs.sort((left, right) => PHASE_PRIORITY[left.phase] - PHASE_PRIORITY[right.phase]
      || (left.queuedAt ?? "").localeCompare(right.queuedAt ?? "")
      || left.jobId.localeCompare(right.jobId));
    return { observedAt: observedAt.toISOString(), jobs };
  }
}
