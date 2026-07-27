import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { syncDirectoryStrict } from "../atomic-file.ts";
import { withFileLock } from "../file-lock.ts";
import { isErrno, isRecord } from "../state-validation.ts";
import type { MemoryBranch, ReviewAdmissionResult } from "../types.ts";
import { createOrCompareJsonFile, readBoundedPrivateJson } from "./admission-artifacts.ts";
import type { ReviewJob, ReviewMemoryBranch } from "./protocol.ts";

const MAX_PENDING_FEEDBACK = 1_024;
const MAX_PENDING_BYTES = 1_024;
const MAX_READY_BYTES = 64 * 1_024;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const JOB_ID = /^review_[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const BRANCH_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;
const ADMISSION_STATUSES = new Set(["applied", "noop", "stale", "rejected"]);

interface PendingFeedback {
  version: 1;
  jobId: string;
  jobDigest: string;
}

export type ReviewFeedbackChange =
  | { kind: "add"; text: string }
  | { kind: "replace"; text: string; oldText: string }
  | { kind: "assess"; text: string }
  | { kind: "remove"; text: string };

export interface ReviewFeedback {
  version: 1;
  jobId: string;
  jobDigest: string;
  branchName: string;
  status: ReviewAdmissionResult["status"];
  messages: string[];
  changes: ReviewFeedbackChange[];
}

function checkedIdentity(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid No Forgetti feedback ${label}.`);
  return value;
}

function checkedText(value: unknown, label: string): string {
  // Sanitized review memory text is bounded at 4,000 characters and an assess
  // change only prefixes its importance, so a shorter bound here would reject
  // real diffs and wedge the mailbox permanently.
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new Error(`Invalid No Forgetti feedback ${label}.`);
  }
  return value;
}

function checkedMessages(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((message) => typeof message !== "string")) {
    throw new Error("Invalid No Forgetti feedback messages.");
  }
  return [...value] as string[];
}

function parseFeedbackChange(value: unknown): ReviewFeedbackChange {
  if (!isRecord(value)) throw new Error("Invalid No Forgetti feedback change.");
  const text = checkedText(value.text, "change text");
  if (value.kind === "add" || value.kind === "remove" || value.kind === "assess") return { kind: value.kind, text };
  if (value.kind !== "replace") throw new Error("Invalid No Forgetti feedback change kind.");
  return { kind: value.kind, text, oldText: checkedText(value.oldText, "previous text") };
}

function parseFeedbackChanges(value: unknown): ReviewFeedbackChange[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("Invalid No Forgetti feedback changes.");
  return value.map(parseFeedbackChange);
}

function parsePending(value: unknown): PendingFeedback {
  if (!isRecord(value) || value.version !== 1) throw new Error("Invalid No Forgetti pending feedback record.");
  return {
    version: 1,
    jobId: checkedIdentity(value.jobId, JOB_ID, "job id"),
    jobDigest: checkedIdentity(value.jobDigest, DIGEST, "job digest"),
  };
}

function parseReady(value: unknown, pending: PendingFeedback): ReviewFeedback {
  if (!isRecord(value) || value.version !== 1) throw new Error("Invalid No Forgetti ready feedback record.");
  const jobId = checkedIdentity(value.jobId, JOB_ID, "job id");
  const jobDigest = checkedIdentity(value.jobDigest, DIGEST, "job digest");
  if (jobId !== pending.jobId || jobDigest !== pending.jobDigest) throw new Error("No Forgetti feedback identity mismatch.");
  if (!ADMISSION_STATUSES.has(String(value.status))) throw new Error("Invalid No Forgetti feedback status.");
  return {
    version: 1,
    jobId,
    jobDigest,
    branchName: checkedIdentity(value.branchName, BRANCH_NAME, "branch name"),
    status: value.status as ReviewFeedback["status"],
    messages: checkedMessages(value.messages),
    changes: parseFeedbackChanges(value.changes),
  };
}

function feedbackChanges(before: ReviewMemoryBranch, after: MemoryBranch): ReviewFeedbackChange[] {
  const beforeById = new Map(before.entries.map((entry) => [entry.id, entry]));
  const afterById = new Map(after.entries.map((entry) => [entry.id, entry]));
  const added: ReviewFeedbackChange[] = [];
  const replaced: ReviewFeedbackChange[] = [];
  const removed: ReviewFeedbackChange[] = [];

  for (const entry of after.entries) {
    const previous = beforeById.get(entry.id);
    if (!previous) added.push({ kind: "add", text: entry.text });
    else if (previous.text !== entry.text) replaced.push({ kind: "replace", text: entry.text, oldText: previous.text });
    // Importance-only changes render as embedded review renders them.
    else if (previous.importance !== entry.importance || previous.importanceAssessedAt !== entry.importanceAssessedAt) {
      replaced.push({ kind: "assess", text: `${entry.importance}: ${entry.text}` });
    }
  }
  for (const entry of before.entries) {
    if (!afterById.has(entry.id)) removed.push({ kind: "remove", text: entry.text });
  }
  return [...added, ...replaced, ...removed];
}

/** Durable project-local mailbox from external review admission back into Pi UI. */
export class ReviewFeedbackInbox {
  readonly projectDir: string;
  readonly root: string;
  readonly pendingDir: string;
  readonly readyDir: string;
  readonly lockPath: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.root = join(projectDir, "service", "review-feedback");
    this.pendingDir = join(this.root, "pending");
    this.readyDir = join(this.root, "ready");
    this.lockPath = join(this.root, ".lock");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.pendingDir, { recursive: true, mode: 0o700 }),
      mkdir(this.readyDir, { recursive: true, mode: 0o700 }),
    ]);
  }

  async register(jobId: string, jobDigest: string): Promise<void> {
    const pending: PendingFeedback = {
      version: 1,
      jobId: checkedIdentity(jobId, JOB_ID, "job id"),
      jobDigest: checkedIdentity(jobDigest, DIGEST, "job digest"),
    };
    await createOrCompareJsonFile(join(this.pendingDir, `${jobId}.json`), pending, MAX_PENDING_BYTES);
  }

  /** Drops interest in a job that never reached the durable queue. */
  async discard(jobId: string): Promise<void> {
    try {
      await unlink(join(this.pendingDir, `${checkedIdentity(jobId, JOB_ID, "job id")}.json`));
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      return;
    }
    await syncDirectoryStrict(this.pendingDir);
  }
}

/** Publishes the exact admitted diff only when Pi registered interest in the job. */
export async function publishReviewFeedback(
  projectDir: string,
  job: ReviewJob,
  result: ReviewAdmissionResult,
): Promise<void> {
  const inbox = new ReviewFeedbackInbox(projectDir);
  let pending: PendingFeedback;
  try {
    pending = parsePending(await readBoundedPrivateJson(join(inbox.pendingDir, `${job.id}.json`), MAX_PENDING_BYTES));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (pending.jobDigest !== job.digest) throw new Error("No Forgetti pending feedback does not match admitted review job.");
  const feedback: ReviewFeedback = {
    version: 1,
    jobId: job.id,
    jobDigest: job.digest,
    branchName: result.branch.name,
    status: result.status,
    messages: result.messages,
    changes: result.status === "applied" ? feedbackChanges(job.branch, result.branch) : [],
  };
  await createOrCompareJsonFile(join(inbox.readyDir, `${job.id}.json`), feedback, MAX_READY_BYTES);
}

export async function consumeReviewFeedback(
  inbox: ReviewFeedbackInbox,
  consume: (feedback: ReviewFeedback) => void,
): Promise<number> {
  return withFileLock(inbox.lockPath, LOCK_TIMEOUT_MS, LOCK_STALE_MS, "review feedback", async () => {
    const names = (await readdir(inbox.pendingDir)).filter((name) => name.endsWith(".json")).sort();
    if (names.length > MAX_PENDING_FEEDBACK) throw new Error("Too many pending No Forgetti feedback records.");
    let consumed = 0;
    for (const name of names) {
      const jobId = checkedIdentity(name.slice(0, -".json".length), JOB_ID, "filename");
      const pendingPath = join(inbox.pendingDir, name);
      const pending = parsePending(await readBoundedPrivateJson(pendingPath, MAX_PENDING_BYTES));
      if (pending.jobId !== jobId) throw new Error("No Forgetti pending feedback filename does not match its record.");
      let ready: unknown;
      try {
        ready = await readBoundedPrivateJson(join(inbox.readyDir, name), MAX_READY_BYTES);
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }
      consume(parseReady(ready, pending));
      await Promise.all([unlink(pendingPath), unlink(join(inbox.readyDir, name))]);
      await Promise.all([syncDirectoryStrict(inbox.pendingDir), syncDirectoryStrict(inbox.readyDir)]);
      consumed += 1;
    }
    return consumed;
  });
}
