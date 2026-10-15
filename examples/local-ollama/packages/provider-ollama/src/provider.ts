import { canonicalize, defineEndpoint } from "@hypit/hypit/endpoint";
import type { EndpointFulfillment, EndpointInvocationContext, EndpointRequest, EndpointSupport } from "@hypit/hypit/endpoint";
import { sealText, textTypes } from "@hypit/hypit/text";
import {
  textGenerationCapabilities, verifyTextGenerationOptions, verifyTextGenerationRequest,
} from "@local/text-generation";
import type { TextGenerationRequest } from "@local/text-generation";

import { createOllamaClient, OllamaError, ollamaDefaults, verifyOllamaModelName } from "./ollama.js";
import type { OllamaChatMessage, OllamaClient } from "./ollama.js";

export const ollamaProviderModuleRef = { name: "@local/provider-ollama", version: "1" } as const;

export type CreateOllamaTextProviderOptions = {
  readonly instance?: string;
  readonly pool?: string;
  /** Ollama tag that serves every `generate-text` request of this Endpoint, e.g. `qwen2.5:1.5b`. */
  readonly model: string;
  readonly baseUrl?: string;
  readonly allowNetworkHost?: boolean;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Ollama `keep_alive`, e.g. `5m` or `0` to unload right after the request (frees RAM sooner). */
  readonly keepAlive?: string;
  /** Ollama `num_ctx`. Small machines keep this modest because context costs memory. */
  readonly contextTokens?: number;
  readonly defaultConcurrency?: number;
  readonly fetch?: typeof globalThis.fetch;
};

function verifyKeepAlive(value: string): string {
  if (!/^(-1|0|\d+(\.\d+)?(ms|s|m|h)?)$/u.test(value)) throw new Error("Ollama keepAlive must look like 5m, 30s, 0 or -1");
  return value;
}

/** Ollama sampling options. Unset fields keep the model's own defaults. */
function samplingOptions(request: TextGenerationRequest, contextTokens: number | undefined): Record<string, number> {
  return {
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { num_predict: request.maxTokens }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...(contextTokens === undefined ? {} : { num_ctx: contextTokens }),
  };
}

/**
 * Planning may present only the options, before upstream prompt Text exists. A complete request
 * is checked in full; neither path contacts the service.
 */
export function ollamaTextSupport(request: EndpointRequest): EndpointSupport {
  try {
    const constraints = request.constraints;
    const complete = constraints !== null && typeof constraints === "object" && !Array.isArray(constraints)
      && "prompt" in constraints;
    if (complete) verifyTextGenerationRequest(constraints);
    else verifyTextGenerationOptions(constraints);
    return { status: "supported" };
  } catch (error) {
    return { status: "unsupported", reason: (error as Error).message };
  }
}

export async function generateOllamaText(
  client: OllamaClient,
  settings: { readonly model: string; readonly keepAlive?: string; readonly contextTokens?: number },
  request: TextGenerationRequest,
  context?: Pick<EndpointInvocationContext, "reportProgress" | "reportDiagnostic">,
): Promise<string> {
  const messages: OllamaChatMessage[] = [
    ...(request.system === undefined ? [] : [{ role: "system" as const, content: request.system }]),
    { role: "user", content: request.prompt },
  ];
  await context?.reportProgress?.({ phase: `Generating text locally with ${settings.model}` });
  const response = await client.chat({
    model: settings.model,
    messages,
    ...(request.format === "json" ? { format: "json" as const } : {}),
    options: samplingOptions(request, settings.contextTokens),
    ...(settings.keepAlive === undefined ? {} : { keepAlive: settings.keepAlive }),
  });
  const content = response.content.trim();
  if (content.length === 0) {
    throw new OllamaError("OLLAMA_EMPTY_OUTPUT", `Ollama model ${settings.model} returned empty text`);
  }
  if (request.format === "json") {
    try { JSON.parse(content); } catch {
      throw new OllamaError("OLLAMA_INVALID_JSON_OUTPUT",
        `Ollama model ${settings.model} did not return valid JSON${response.doneReason === "length" ? " (output hit the token limit; raise max-tokens)" : ""}`);
    }
  }
  // Counts and timings only: prompts and generated text stay out of diagnostics.
  await context?.reportDiagnostic?.({
    level: response.doneReason === "length" ? "warning" : "info",
    message: `Ollama ${response.model} at ${client.baseUrl}: ${response.promptTokens ?? "?"} prompt tokens, `
      + `${response.outputTokens ?? "?"} output tokens, ${response.totalDurationMs ?? "?"} ms`
      + (response.doneReason === "length" ? "; output stopped at the max-tokens limit" : ""),
  });
  return content;
}

export function createOllamaTextProvider(options: CreateOllamaTextProviderOptions) {
  const model = verifyOllamaModelName(options.model);
  const keepAlive = options.keepAlive === undefined ? undefined : verifyKeepAlive(options.keepAlive);
  const contextTokens = options.contextTokens;
  if (contextTokens !== undefined && (!Number.isSafeInteger(contextTokens) || contextTokens < 256)) {
    throw new Error("Ollama contextTokens must be an integer of at least 256");
  }
  const client = createOllamaClient({
    baseUrl: options.baseUrl ?? ollamaDefaults.baseUrl,
    ...(options.allowNetworkHost === undefined ? {} : { allowNetworkHost: options.allowNetworkHost }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const settings = {
    model,
    ...(keepAlive === undefined ? {} : { keepAlive }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
  };
  const instance = options.instance ?? "ollama.local";

  const endpoint = defineEndpoint({
    instance,
    pool: options.pool ?? instance,
    // Inference runs on this machine; there is no Provider charge and no credential.
    pricing: { kind: "local" },
    // One local model generally saturates a small machine; raise only with spare RAM/VRAM.
    defaultConcurrency: options.defaultConcurrency ?? 1,
    capabilities: [{
      lifecycle: "immediate" as const,
      capability: textGenerationCapabilities.generate,
      returns: textTypes.text,
      supports: ollamaTextSupport,
      // Local, unpaid and side-effect free, so authoring previews may evaluate it.
      transient: true,
      handler: async (context: EndpointInvocationContext): Promise<EndpointFulfillment> => {
        const request = verifyTextGenerationRequest(context.need.constraints);
        const text = await generateOllamaText(client, settings, request, context);
        return { value: { kind: "inline", value: canonicalize(sealText(text)) } };
      },
    }],
  });
  return { endpoint, client, model };
}
