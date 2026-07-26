import { open } from "node:fs/promises";
import { join, resolve } from "node:path";

import { atomicWriteFile } from "../atomic-file.ts";
import { ProjectMemoryStore } from "../store.ts";
import { STORE_FILE_BYTE_LIMIT, STORE_VERSION } from "../types.ts";
import type { ReviewJob, ReviewOutcome } from "./protocol.ts";

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
}

export interface ProposalCommitter {
  commit(job: ReviewJob, outcome: ReviewOutcome): Promise<AdmissionReceipt>;
}

interface ProjectMetadataRecord {
  version: number;
  projectRoot: string;
  projectKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function parseReceipt(value: unknown, job: ReviewJob): AdmissionReceipt {
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
    || value.messages.some((message) => typeof message !== "string")) {
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
    try {
      return parseReceipt(await readBoundedJson(path), job);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    }

    const projectDir = join(this.agentDir, "no-forgetti", job.projectKey);
    const metadata = parseMetadata(await readBoundedJson(join(projectDir, "project.json")), job.projectKey);
    const store = new ProjectMemoryStore(metadata.projectRoot, { storageRoot: this.agentDir });
    await store.initialize();
    const results = await store.applyOperations(
      job.branch.name,
      outcome.operations,
      undefined,
      "background_review",
      job.baseBranchDigest,
    );
    const branch = results.at(-1)?.branch ?? await store.loadBranch(job.branch.name);
    const messages = results.map((result) => result.message);
    const rejected = messages.find((message) => message.startsWith("Review batch rejected;"));
    const status: AdmissionStatus = rejected
      ? rejected.includes("Stale memory snapshot") ? "stale" : "rejected"
      : results.some((result) => result.changed) ? "applied" : "noop";
    const receipt: AdmissionReceipt = {
      version: 1,
      proposalId: job.id,
      jobDigest: job.digest,
      projectKey: job.projectKey,
      branchName: job.branch.name,
      baseBranchDigest: job.baseBranchDigest,
      status,
      committedAt: new Date().toISOString(),
      resultingBranchDigest: store.branchDigest(branch),
      messages,
    };
    await atomicWriteFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
    await store.finishReview(job.branch.name, status === "applied" || status === "noop").catch(() => undefined);
    return receipt;
  }
}
