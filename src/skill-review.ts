import { complete, type Message } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ModelRunError, type ModelRunner, type ReviewModelProvenance } from "./service/model-runner.ts";
import { SkillReviewEngine, type SkillReviewExecutionOutcome } from "./skill-review-engine.ts";
import type { SkillReviewJob } from "./skill-review-job.ts";
import type { RequestedSkillReviewerProfile } from "./skill-review-provenance.ts";

const SKILL_REVIEW_MAX_OUTPUT_TOKENS = 8_192;
const SKILL_REVIEW_REASONING_EFFORT = "xhigh" as const;

export interface SkillReviewResult {
  outcome: SkillReviewExecutionOutcome;
  profile: RequestedSkillReviewerProfile;
}

function provenance(request: {
  model: NonNullable<ExtensionContext["model"]>;
  response: Awaited<ReturnType<typeof complete>>;
  started: Date;
  completed: Date;
}): ReviewModelProvenance {
  const { model, response, started, completed } = request;
  return {
    provider: response.provider || model.provider,
    model: model.id,
    api: response.api || model.api,
    ...(response.responseModel ? { responseModel: response.responseModel } : {}),
    ...(response.responseId ? { responseId: response.responseId } : {}),
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    durationMs: Math.max(0, completed.getTime() - started.getTime()),
    usage: {
      input: response.usage.input,
      output: response.usage.output,
      cacheRead: response.usage.cacheRead,
      cacheWrite: response.usage.cacheWrite,
      ...(response.usage.reasoning === undefined ? {} : { reasoning: response.usage.reasoning }),
      totalTokens: response.usage.totalTokens,
      cost: {
        input: response.usage.cost.input,
        output: response.usage.cost.output,
        cacheRead: response.usage.cost.cacheRead,
        cacheWrite: response.usage.cost.cacheWrite,
        total: response.usage.cost.total,
      },
    },
  };
}

export async function requestSkillReviewPlan(
  ctx: ExtensionContext,
  job: Readonly<SkillReviewJob>,
  signal?: AbortSignal,
): Promise<SkillReviewResult> {
  const model = ctx.model;
  const profile: RequestedSkillReviewerProfile = model
    ? {
      provider: model.provider,
      model: model.id,
      api: model.api,
      reasoningEffort: SKILL_REVIEW_REASONING_EFFORT,
      maxOutputTokens: SKILL_REVIEW_MAX_OUTPUT_TOKENS,
    }
    : {
      provider: "unavailable",
      model: "unavailable",
      api: "unavailable",
      reasoningEffort: SKILL_REVIEW_REASONING_EFFORT,
      maxOutputTokens: SKILL_REVIEW_MAX_OUTPUT_TOKENS,
    };
  const runner: ModelRunner = {
    async run(request, hooks = {}) {
      if (!model) throw new ModelRunError("model_not_found", "No active model is available for project skill review.", { retryable: true });
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        throw new ModelRunError("auth_unavailable", "No model authentication is available for project skill review.", { retryable: true });
      }
      const started = new Date();
      const message: Message = {
        role: "user",
        content: [{ type: "text", text: request.prompt }],
        timestamp: started.getTime(),
      };
      let response: Awaited<ReturnType<typeof complete>>;
      try {
        response = await complete(
          model,
          { systemPrompt: request.systemPrompt, messages: [message] },
          {
            apiKey: auth.apiKey,
            headers: auth.headers,
            env: auth.env,
            reasoningEffort: SKILL_REVIEW_REASONING_EFFORT,
            maxTokens: SKILL_REVIEW_MAX_OUTPUT_TOKENS,
            signal: request.signal,
          },
        );
      } catch (error) {
        const aborted = request.signal?.aborted ?? false;
        throw new ModelRunError(aborted ? "aborted" : "provider_error", "Project skill model request failed.", {
          retryable: !aborted,
          cause: error,
        });
      }
      const completed = new Date();
      const observed = provenance({ model, response, started, completed });
      await hooks.observe?.(observed);
      if (response.stopReason === "aborted") throw new ModelRunError("aborted", "Project skill review was aborted.", { retryable: false, provenance: observed });
      if (response.stopReason === "error") throw new ModelRunError("provider_error", "Project skill reviewer returned an error.", { retryable: true, provenance: observed });
      if (response.stopReason === "length") throw new ModelRunError("output_truncated", "Project skill reviewer output was truncated.", { retryable: true, provenance: observed });
      if (response.stopReason === "toolUse") throw new ModelRunError("unexpected_tool_use", "Project skill reviewer attempted tool use.", { retryable: false, provenance: observed });
      const text = response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (!text.trim()) throw new ModelRunError("empty_model_output", "Project skill reviewer returned no text.", { retryable: true, provenance: observed });
      return { text, provenance: observed };
    },
  };

  const outcome = await new SkillReviewEngine(runner).review(job, signal);
  return { outcome, profile };
}
