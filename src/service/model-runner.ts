import { join, resolve } from "node:path";

import { complete, type Usage } from "@earendil-works/pi-ai/compat";
import { AuthStorage, getAgentDir, ModelRegistry } from "@earendil-works/pi-coding-agent";

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

/** Narrow tool-less seam used by ReviewEngine and its fakes. */
export interface ModelRunner {
  run(request: ModelRunRequest): Promise<ModelRunResult>;
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
  return /(?:\b401\b|\b403\b|unauthori[sz]ed|forbidden|authentication|invalid api key|invalid token)/iu.test(message);
}

/**
 * Direct Pi model adapter. Credentials and custom models are reloaded from
 * agentDir for every call; neither resolved auth nor provider headers cross the
 * ModelRunner seam or enter a review job/outcome.
 */
export class PiModelRunner implements ModelRunner {
  readonly agentDir: string;

  private readonly profile: ReviewerProfile;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly maxOutputTokens: number;
  private readonly timeoutMs: number;
  private readonly clock: () => Date;

  constructor(profile: ReviewerProfile, options: PiModelRunnerOptions = {}) {
    this.profile = { ...profile };
    this.agentDir = resolve(options.agentDir ?? getAgentDir());
    this.authStorage = AuthStorage.create(join(this.agentDir, "auth.json"));
    this.modelRegistry = ModelRegistry.create(this.authStorage, join(this.agentDir, "models.json"));
    this.maxOutputTokens = positiveInteger(
      options.maxOutputTokens ?? DEFAULT_REVIEW_MAX_OUTPUT_TOKENS,
      "review output-token limit",
    );
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS, "review timeout");
    this.clock = options.now ?? (() => new Date());
  }

  async run(request: ModelRunRequest): Promise<ModelRunResult> {
    if (!request.prompt) throw new Error("Review prompt is required.");
    if (!request.systemPrompt) throw new Error("Review system prompt is required.");
    if (request.signal?.aborted) {
      throw new ModelRunError("aborted", "Review model call was aborted.", { retryable: true });
    }

    this.authStorage.reload();
    this.modelRegistry.refresh();
    const registryError = this.modelRegistry.getError();
    if (registryError) {
      throw new ModelRunError("model_registry_invalid", `Reviewer model registry is invalid: ${registryError}`, {
        retryable: true,
      });
    }
    const model = this.modelRegistry.find(this.profile.provider, this.profile.model);
    if (!model) {
      throw new ModelRunError(
        "model_not_found",
        `Reviewer model '${this.profile.provider}/${this.profile.model}' is not registered.`,
        { retryable: true },
      );
    }
    const auth = await this.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      const detail = auth.ok ? `No persistent auth is configured for '${model.provider}'.` : auth.error;
      throw new ModelRunError("auth_unavailable", `Reviewer auth unavailable. ${detail}`, { retryable: true });
    }

    const started = validDate(this.clock);
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.timeoutMs);
    timeout.unref?.();
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const response = await complete(
        model,
        {
          systemPrompt: request.systemPrompt,
          messages: [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: started.getTime() }],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          maxTokens: Math.min(this.maxOutputTokens, model.maxTokens),
          reasoningEffort: this.profile.reasoningEffort,
          signal,
          timeoutMs: this.timeoutMs,
          maxRetries: 1,
        },
      );
      const completed = validDate(this.clock);
      const provenance: ReviewModelProvenance = {
        provider: response.provider || model.provider,
        model: model.id,
        api: response.api || model.api,
        ...(response.responseModel ? { responseModel: response.responseModel } : {}),
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        durationMs: Math.max(0, completed.getTime() - started.getTime()),
        usage: usageOf(response.usage),
      };

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
    } catch (error) {
      if (error instanceof ModelRunError) throw error;
      if (request.signal?.aborted) {
        throw new ModelRunError("aborted", "Review model call was aborted.", { retryable: true, cause: error });
      }
      if (timeoutController.signal.aborted) {
        throw new ModelRunError("model_timeout", "Review model call timed out.", { retryable: true, cause: error });
      }
      const message = error instanceof Error ? error.message : String(error);
      const authFailure = authProviderFailure(message);
      throw new ModelRunError(authFailure ? "auth_unavailable" : "provider_error", message, {
        retryable: authFailure || retryableProviderFailure(message),
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
