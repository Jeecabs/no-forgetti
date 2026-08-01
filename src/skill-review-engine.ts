import { createHash } from "node:crypto";

import { ModelRunError, type ModelRunErrorCode, type ModelRunHooks, type ModelRunner, type ReviewModelProvenance } from "./service/model-runner.ts";
import { buildSkillReviewPrompt, SKILL_REVIEWER_SYSTEM_PROMPT } from "./skill-authoring.ts";
import { serializeSkillReviewJob, skillReviewRequestDigest, type SkillReviewJob } from "./skill-review-job.ts";
import { parseSkillReviewPlan, validateSkillReviewPlanForPacket } from "./skill-review-plan.ts";
import { MAX_SKILL_DESCRIPTION_CHARS, type SkillReviewPlan } from "./skill-types.ts";

export interface SkillReviewAttempt {
  ordinal: number;
  promptDigest: string;
  requestDigest: string;
  outputDigest: string;
  provenance: ReviewModelProvenance;
  validationErrorCode?: "invalid_output";
}

export interface SkillReviewExecutionOutcome {
  version: 1;
  kind: "project-skill-review-outcome";
  jobId: string;
  jobDigest: string;
  disposition: "proposed" | "no-change" | "invalid-output" | "runner-failure" | "aborted";
  plan: SkillReviewPlan;
  attempts: SkillReviewAttempt[];
  failure?: {
    code: ModelRunErrorCode | "unknown_runner_failure";
    retryable: boolean;
    provenance?: ReviewModelProvenance;
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function correction(error: unknown): string {
  const message = error instanceof Error ? error.message : "schema validation failed";
  return `\n\nYour previous output was invalid: ${message}. Repeat the authorship process, repair that defect, and return only valid JSON. Descriptions must be one sentence ending in a period and at most ${MAX_SKILL_DESCRIPTION_CHARS} characters.`;
}

/** Tool-less immutable job -> typed outcome seam shared by eval and pinned reviewers. */
export class SkillReviewEngine {
  private readonly runner: ModelRunner;

  constructor(runner: ModelRunner) {
    this.runner = runner;
  }

  async review(
    job: Readonly<SkillReviewJob>,
    signal?: AbortSignal,
    hooks: ModelRunHooks = {},
  ): Promise<SkillReviewExecutionOutcome> {
    serializeSkillReviewJob(job);
    const initialPrompt = buildSkillReviewPrompt(job.packet);
    const attempts: SkillReviewAttempt[] = [];
    let repair = "";
    for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
      const prompt = `${initialPrompt}${repair}`;
      let response;
      try {
        response = await this.runner.run({
          systemPrompt: SKILL_REVIEWER_SYSTEM_PROMPT,
          prompt,
          signal,
        }, hooks);
      } catch (error) {
        const modeled = error instanceof ModelRunError ? error : undefined;
        const aborted = signal?.aborted || modeled?.code === "aborted";
        return {
          version: 1,
          kind: "project-skill-review-outcome",
          jobId: job.id,
          jobDigest: job.digest,
          disposition: aborted ? "aborted" : "runner-failure",
          plan: { operations: [] },
          attempts,
          failure: {
            code: modeled?.code ?? (aborted ? "aborted" : "unknown_runner_failure"),
            retryable: modeled?.retryable ?? !aborted,
            ...(modeled?.provenance ? { provenance: modeled.provenance } : {}),
          },
        };
      }
      const promptDigest = digest(prompt);
      const attempt: SkillReviewAttempt = {
        ordinal,
        promptDigest,
        requestDigest: ordinal === 1
          ? job.contract.requestDigest
          : skillReviewRequestDigest({
            promptVersion: job.contract.promptVersion,
            systemPromptDigest: job.contract.systemPromptDigest,
            promptDigest,
          }),
        outputDigest: digest(response.text),
        provenance: response.provenance,
      };
      try {
        const plan = validateSkillReviewPlanForPacket(parseSkillReviewPlan(response.text), job.packet);
        attempts.push(attempt);
        return {
          version: 1,
          kind: "project-skill-review-outcome",
          jobId: job.id,
          jobDigest: job.digest,
          disposition: plan.operations.length > 0 ? "proposed" : "no-change",
          plan,
          attempts,
        };
      } catch (error) {
        attempts.push({ ...attempt, validationErrorCode: "invalid_output" });
        if (ordinal === 2) {
          return {
            version: 1,
            kind: "project-skill-review-outcome",
            jobId: job.id,
            jobDigest: job.digest,
            disposition: "invalid-output",
            plan: { operations: [] },
            attempts,
          };
        }
        repair = correction(error);
      }
    }
    throw new Error("Project skill review engine exhausted unexpectedly.");
  }
}
