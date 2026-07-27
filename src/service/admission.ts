import { open } from "node:fs/promises";
import { join, resolve } from "node:path";

import { isRecord } from "../state-validation.ts";
import { ProjectMemoryStore } from "../store.ts";
import { STORE_FILE_BYTE_LIMIT, STORE_VERSION } from "../types.ts";
import { admissionJsonDigest, createOrCompareJsonFile } from "./admission-artifacts.ts";
import { publishReviewFailure, publishReviewFeedback } from "./feedback.ts";
import type { ReviewFailure, ReviewJob, ReviewOutcome } from "./protocol.ts";

export type AdmissionStatus = "applied" | "noop" | "stale" | "rejected";

export interface AdmissionReceipt {
  version: 1;
  proposalId: string;
  jobDigest: string;
  projectKey: string;
  branchName: string;
  baseBranchDigest: string;
  status: AdmissionStatus;
  committedAt: string;
  resultingBranchDigest: string;
  messages: string[];
  transactionVersion: 1;
  transactionId: string;
  outcomeDigest: string;
  bindingDigest?: string;
  revisionId?: string;
}

export interface ProposalCommitter {
  commit(job: ReviewJob, outcome: ReviewOutcome): Promise<AdmissionReceipt>;
  /** Reports a dead-lettered job back to any registered feedback interest. */
  failed?(job: ReviewJob, failure: ReviewFailure): Promise<void>;
}

interface ProjectMetadataRecord {
  version: number;
  projectRoot: string;
  projectKey: string;
}

async function readBoundedJson(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0 || info.size > STORE_FILE_BYTE_LIMIT) {
      throw new Error("Invalid No Forgetti project metadata size.");
    }
    const content = await file.readFile();
    if (content.byteLength > STORE_FILE_BYTE_LIMIT) throw new Error("No Forgetti project metadata is oversized.");
    return JSON.parse(content.toString("utf8")) as unknown;
  } finally {
    await file.close();
  }
}

function parseMetadata(value: unknown, projectKey: string): ProjectMetadataRecord {
  if (!isRecord(value)
    || value.version !== STORE_VERSION
    || value.projectKey !== projectKey
    || typeof value.projectRoot !== "string"
    || !value.projectRoot) {
    throw new Error("Review job does not match valid No Forgetti project metadata.");
  }
  return { version: STORE_VERSION, projectRoot: value.projectRoot, projectKey };
}

function receiptPath(agentDir: string, job: ReviewJob): string {
  return join(agentDir, "no-forgetti", job.projectKey, "service", "commit-receipts", `${job.id}.json`);
}

/** Binds every immutable field needed to reconstruct and validate a receipt. */
export function admissionBindingDigest(job: ReviewJob, outcome: ReviewOutcome): string {
  return admissionJsonDigest({
    transactionVersion: 1,
    transactionId: job.id,
    jobDigest: job.digest,
    projectKey: job.projectKey,
    branchName: job.branch.name,
    baseBranchDigest: job.baseBranchDigest,
    outcomeDigest: admissionJsonDigest(outcome as unknown as object),
  });
}

function parseReceipt(value: unknown, job: ReviewJob, outcome: ReviewOutcome): AdmissionReceipt {
  if (!isRecord(value)
    || value.version !== 1
    || value.proposalId !== job.id
    || value.jobDigest !== job.digest
    || value.projectKey !== job.projectKey
    || value.branchName !== job.branch.name
    || value.baseBranchDigest !== job.baseBranchDigest
    || (value.status !== "applied" && value.status !== "noop" && value.status !== "stale" && value.status !== "rejected")
    || typeof value.committedAt !== "string"
    || typeof value.resultingBranchDigest !== "string"
    || !Array.isArray(value.messages)
    || value.messages.some((message) => typeof message !== "string")
    || value.transactionVersion !== 1
    || value.transactionId !== job.id
    || value.outcomeDigest !== admissionJsonDigest(outcome as unknown as object)
    || value.bindingDigest !== admissionBindingDigest(job, outcome)
    || (value.revisionId !== undefined && (typeof value.revisionId !== "string" || !/^[a-f0-9-]{36}$/u.test(value.revisionId)))) {
    throw new Error("Invalid or conflicting No Forgetti admission receipt.");
  }
  return value as unknown as AdmissionReceipt;
}

/** Applies admitted external proposals through the existing JSON authority and CAS lock. */
export class FileMemoryProposalCommitter implements ProposalCommitter {
  readonly agentDir: string;

  constructor(agentDir: string) {
    this.agentDir = resolve(agentDir);
  }

  async commit(job: ReviewJob, outcome: ReviewOutcome): Promise<AdmissionReceipt> {
    if (outcome.status !== "completed" || outcome.jobId !== job.id || outcome.jobDigest !== job.digest) {
      throw new Error("Only a matching completed review outcome can be admitted.");
    }
    const path = receiptPath(this.agentDir, job);
    const outcomeDigest = admissionJsonDigest(outcome as unknown as object);
    const bindingDigest = admissionBindingDigest(job, outcome);
    let durableReceipt: AdmissionReceipt | undefined;
    try {
      durableReceipt = parseReceipt(await readBoundedJson(path), job, outcome);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    }

    const projectDir = join(this.agentDir, "no-forgetti", job.projectKey);
    const metadata = parseMetadata(await readBoundedJson(join(projectDir, "project.json")), job.projectKey);
    const store = new ProjectMemoryStore(metadata.projectRoot, { storageRoot: this.agentDir });
    await store.initialize();
    if (durableReceipt) {
      await store.retireReviewAdmission(job.id, bindingDigest);
      return durableReceipt;
    }
    const result = await store.applyReviewAdmission({
      transactionId: job.id,
      branchName: job.branch.name,
      expectedBranchDigest: job.baseBranchDigest,
      bindingDigest,
      operations: outcome.operations,
    });
    const receipt: AdmissionReceipt = {
      version: 1,
      proposalId: job.id,
      jobDigest: job.digest,
      projectKey: job.projectKey,
      branchName: job.branch.name,
      baseBranchDigest: job.baseBranchDigest,
      status: result.status,
      committedAt: result.committedAt,
      resultingBranchDigest: result.resultingBranchDigest,
      messages: result.messages,
      transactionVersion: 1,
      transactionId: result.transactionId,
      outcomeDigest,
      bindingDigest,
      ...(result.revisionId ? { revisionId: result.revisionId } : {}),
    };
    await publishReviewFeedback(projectDir, job, result);
    await createOrCompareJsonFile(path, receipt, STORE_FILE_BYTE_LIMIT);
    const published = parseReceipt(await readBoundedJson(path), job, outcome);
    await store.retireReviewAdmission(job.id, bindingDigest);
    return published;
  }

  async failed(job: ReviewJob, failure: ReviewFailure): Promise<void> {
    await publishReviewFailure(join(this.agentDir, "no-forgetti", job.projectKey), job, failure);
  }
}
