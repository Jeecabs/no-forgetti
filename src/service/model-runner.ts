import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { ModelsError, type Usage } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { ReviewerProfile } from "./config.ts";
import type { ReviewModelProvenance, ReviewModelUsage } from "./protocol.ts";

export type { ReviewModelProvenance, ReviewModelUsage } from "./protocol.ts";

export const DEFAULT_REVIEW_MAX_OUTPUT_TOKENS = 2_048;
export const DEFAULT_REVIEW_TIMEOUT_MS = 2 * 60_000;

export interface ModelRunRequest {
  systemPrompt: string;
  prompt: string;
  signal?: AbortSignal;
}

export interface ModelRunResult {
  text: string;
  provenance: ReviewModelProvenance;
}

export interface ModelDispatchContext {
  provider: string;
  model: string;
  api: string;
  requestDigest: string;
  hold: { tokens: number; costUsd: number };
}

export interface ModelRunHooks {
  beforeDispatch?: (context: ModelDispatchContext) => void | Promise<void>;
  observe?: (provenance: ReviewModelProvenance) => void | Promise<void>;
}

/** Narrow tool-less seam used by ReviewEngine and its fakes. */
export interface ModelRunner {
  run(request: ModelRunRequest, hooks?: ModelRunHooks): Promise<ModelRunResult>;
}

export type ModelRunErrorCode =
  | "aborted"
  | "auth_unavailable"
  | "model_not_found"
  | "model_registry_invalid"
  | "model_timeout"
  | "output_truncated"
  | "provider_error"
  | "unexpected_tool_use"
  | "empty_model_output";

export class ModelRunError extends Error {
  readonly code: ModelRunErrorCode;
  readonly retryable: boolean;
  readonly provenance?: ReviewModelProvenance;

  constructor(
    code: ModelRunErrorCode,
    message: string,
    options: { retryable: boolean; cause?: unknown; provenance?: ReviewModelProvenance },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelRunError";
    this.code = code;
    this.retryable = options.retryable;
    this.provenance = options.provenance;
  }
}

export interface PiModelRunnerOptions {
  agentDir?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  now?: () => Date;
  createModelRuntime?: typeof ModelRuntime.create;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${label}.`);
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!Number.isFinite(value.getTime())) throw new Error("Invalid reviewer clock.");
  return value;
}

function usageOf(value: Usage): ReviewModelUsage {
  return {
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
    totalTokens: value.totalTokens,
    cost: {
      input: value.cost.input,
      output: value.cost.output,
      cacheRead: value.cost.cacheRead,
      cacheWrite: value.cost.cacheWrite,
      total: value.cost.total,
    },
  };
}

function retryableProviderFailure(message: string): boolean {
  return /(?:429|rate.?limit|overload|temporar|timeout|timed out|network|socket|connection|fetch failed|ECONN|EAI_AGAIN|\b5\d\d\b)/iu.test(message);
}

function authProviderFailure(message: string): boolean {
  return /(?:\b401\b|\b403\b|unauthori[sz]ed|forbidden|authentication|invalid api key|invalid token|provider is not configured|credentials? unavailable)/iu.test(message);
}

function dispatchContext(
  request: ModelRunRequest,
  model: { provider: string; id: string; api: string; contextWindow: number; maxTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number }> } },
  maxOutputTokens: number,
): ModelDispatchContext {
  const outputTokens = Math.min(maxOutputTokens, model.maxTokens);
  const inputTokens = Math.min(
    model.contextWindow,
    Buffer.byteLength(`${request.systemPrompt}\n${request.prompt}`, "utf8") + 4_096,
  );
  const rates = [model.cost, ...(model.cost.tiers ?? [])];
  const maxRate = (key: "input" | "output" | "cacheRead" | "cacheWrite") => Math.max(...rates.map((rate) => rate[key]));
  // Input/cache categories may overlap in provider reports. Summing all three
  // rate ceilings is deliberately conservative for a hard reservation.
  const costUsd = (
    inputTokens * (maxRate("input") + maxRate("cacheRead") + maxRate("cacheWrite"))
    + outputTokens * maxRate("output")
  ) / 1_000_000;
  const requestDigest = createHash("sha256")
    .update(`review-model-request/v1\n${model.provider}\n${model.id}\n${model.api}\n${request.systemPrompt}\n${request.prompt}`, "utf8")
    .digest("hex");
  return {
    provider: model.provider,
    model: model.id,
    api: model.api,
    requestDigest,
    hold: { tokens: inputTokens + outputTokens, costUsd },
  };
}

/**
 * Direct Pi model adapter. Credentials and custom models are reloaded from
 * agentDir for every call; neither resolved auth nor provider headers cross the
 * ModelRunner seam or enter a review job/outcome.
 */
export class PiModelRunner implements ModelRunner {
  readonly agentDir: string;

  private readonly profile: ReviewerProfile;
  private readonly maxOutputTokens: number;
  private readonly timeoutMs: number;
  private readonly clock: () => Date;
  private readonly createModelRuntime: typeof ModelRuntime.create;

  constructor(profile: ReviewerProfile, options: PiModelRunnerOptions = {}) {
    this.profile = { ...profile };
    this.agentDir = resolve(options.agentDir ?? getAgentDir());
    this.maxOutputTokens = positiveInteger(
      options.maxOutputTokens ?? DEFAULT_REVIEW_MAX_OUTPUT_TOKENS,
      "review output-token limit",
    );
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS, "review timeout");
    this.clock = options.now ?? (() => new Date());
    this.createModelRuntime = options.createModelRuntime ?? ModelRuntime.create;
  }

  async run(request: ModelRunRequest, hooks: ModelRunHooks = {}): Promise<ModelRunResult> {
    if (!request.prompt) throw new Error("Review prompt is required.");
    if (!request.systemPrompt) throw new Error("Review system prompt is required.");
    if (request.signal?.aborted) {
      throw new ModelRunError("aborted", "Review model call was aborted.", { retryable: true });
    }

    let modelRuntime: ModelRuntime;
    try {
      modelRuntime = await this.createModelRuntime({
        authPath: join(this.agentDir, "auth.json"),
        modelsPath: join(this.agentDir, "models.json"),
      });
    } catch (error) {
      throw new ModelRunError("model_registry_invalid", "Reviewer model runtime could not load persistent configuration.", {
        retryable: true,
        cause: error,
      });
    }
    const registryError = modelRuntime.getError();
    if (registryError) {
      throw new ModelRunError("model_registry_invalid", `Reviewer model registry is invalid: ${registryError}`, {
        retryable: true,
      });
    }
    const model = modelRuntime.getModel(this.profile.provider, this.profile.model);
    if (!model) {
      throw new ModelRunError(
        "model_not_found",
        `Reviewer model '${this.profile.provider}/${this.profile.model}' is not registered.`,
        { retryable: true },
      );
    }
    let auth;
    try {
      auth = await modelRuntime.getAuth(model);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelRunError("auth_unavailable", `Reviewer model credentials are unavailable: ${message}`, {
        retryable: true,
        cause: error,
      });
    }
    if (!auth) {
      throw new ModelRunError(
        "auth_unavailable",
        `Reviewer provider '${this.profile.provider}' is not configured.`,
        { retryable: true },
      );
    }
    if (request.signal?.aborted) {
      throw new ModelRunError("aborted", "Review model call was aborted.", { retryable: true });
    }
    const started = validDate(this.clock);
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.timeoutMs);
    timeout.unref?.();
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      await hooks.beforeDispatch?.(dispatchContext(request, model, this.maxOutputTokens));
      let response;
      try {
        response = await modelRuntime.completeSimple(
          model,
          {
            systemPrompt: request.systemPrompt,
            messages: [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: started.getTime() }],
          },
          {
            maxTokens: Math.min(this.maxOutputTokens, model.maxTokens),
            ...(this.profile.reasoningEffort === "off" ? {} : { reasoning: this.profile.reasoningEffort }),
            ...(auth.auth.apiKey === undefined ? {} : { apiKey: auth.auth.apiKey }),
            ...(auth.auth.headers === undefined ? {} : { headers: auth.auth.headers }),
            ...(auth.env === undefined ? {} : { env: auth.env }),
            signal,
            timeoutMs: this.timeoutMs,
            // The durable daemon owns retries and their budget accounting.
            maxRetries: 0,
          },
        );
      } catch (error) {
        if (error instanceof ModelRunError) throw error;
        if (request.signal?.aborted) {
          throw new ModelRunError("aborted", "Review model call was aborted.", { retryable: true, cause: error });
        }
        if (timeoutController.signal.aborted) {
          throw new ModelRunError("model_timeout", "Review model call timed out.", { retryable: true, cause: error });
        }
        const message = error instanceof Error ? error.message : String(error);
        const authFailure = error instanceof ModelsError
          ? error.code === "auth" || error.code === "oauth"
          : authProviderFailure(message);
        throw new ModelRunError(authFailure ? "auth_unavailable" : "provider_error", message, {
          retryable: authFailure || retryableProviderFailure(message),
          cause: error,
        });
      }
      const completed = validDate(this.clock);
      const provenance: ReviewModelProvenance = {
        provider: response.provider || model.provider,
        model: model.id,
        api: response.api || model.api,
        ...(response.responseModel ? { responseModel: response.responseModel } : {}),
        ...(response.responseId ? { responseId: response.responseId } : {}),
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        durationMs: Math.max(0, completed.getTime() - started.getTime()),
        usage: usageOf(response.usage),
      };
      await hooks.observe?.(provenance);

      if (response.stopReason === "aborted") {
        const timedOut = timeoutController.signal.aborted && !request.signal?.aborted;
        throw new ModelRunError(
          timedOut ? "model_timeout" : "aborted",
          timedOut ? "Review model call timed out." : "Review model call was aborted.",
          { retryable: true, provenance },
        );
      }
      if (response.stopReason === "error") {
        const message = response.errorMessage || "Review provider returned an error.";
        const authFailure = authProviderFailure(message);
        throw new ModelRunError(authFailure ? "auth_unavailable" : "provider_error", message, {
          retryable: authFailure || retryableProviderFailure(message),
          provenance,
        });
      }
      if (response.stopReason === "length") {
        throw new ModelRunError("output_truncated", "Review model output reached its token limit.", {
          retryable: true,
          provenance,
        });
      }
      if (response.stopReason === "toolUse") {
        throw new ModelRunError("unexpected_tool_use", "Tool-less reviewer unexpectedly requested a tool.", {
          retryable: true,
          provenance,
        });
      }
      const text = response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!text) {
        throw new ModelRunError("empty_model_output", "Review model returned no text.", {
          retryable: true,
          provenance,
        });
      }
      return { text, provenance };
    } finally {
      clearTimeout(timeout);
    }
  }
}
