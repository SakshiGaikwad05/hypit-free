import { canonicalize, defineEndpoint } from "@hypit/hypit/endpoint";
import type { EndpointFulfillment, EndpointInvocationContext, EndpointRequest, EndpointSupport } from "@hypit/hypit/endpoint";
import { sealText, textTypes } from "@hypit/hypit/text";
import { ollamaBaseUrl, ollamaDefaults, verifyOllamaModelName } from "@local/provider-ollama";
import {
  textGenerationCapabilities, verifyTextGenerationOptions, verifyTextGenerationRequest,
} from "@local/text-generation";
import type { TextGenerationRequest } from "@local/text-generation";

import { ClaudeCliError, createClaudeRunner, findClaudeOnPath, resolveClaudeCommand } from "./claude.js";
import type { ClaudeLauncher, ClaudeRunner } from "./claude.js";

export const claudeProviderModuleRef = { name: "@local/provider-claude", version: "1" } as const;

const defaultSystem = "You are a precise writing assistant for short-form video. Answer the user's request directly "
  + "with the requested text only: no preamble, no quotes, no commentary.";

export type CreateClaudeTextProviderOptions = {
  readonly instance?: string;
  readonly pool?: string;
  /** Absolute path to `claude.cmd` or the claude executable. Omitted: found on PATH. */
  readonly command?: string;
  /** Test seam: an explicit launcher instead of resolving `command`. */
  readonly launcher?: ClaudeLauncher;
  /** Ollama model tag the CLI runs, e.g. `qwen2.5:1.5b`. */
  readonly model: string;
  readonly ollamaBaseUrl?: string;
  readonly allowNetworkHost?: boolean;
  readonly requestTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly defaultConcurrency?: number;
};

/** The Claude CLI exposes no sampling controls, so requests that set them are refused, not altered. */
export function claudeTextSupport(request: EndpointRequest): EndpointSupport {
  try {
    const constraints = request.constraints;
    const complete = constraints !== null && typeof constraints === "object" && !Array.isArray(constraints)
      && "prompt" in constraints;
    const parsed = complete ? verifyTextGenerationRequest(constraints) : verifyTextGenerationOptions(constraints);
    const unsupported = (["temperature", "maxTokens", "seed"] as const).filter((name) => parsed[name] !== undefined);
    if (unsupported.length > 0) {
      const names = unsupported.map((name) => name === "maxTokens" ? "max-tokens" : name).join(", ");
      return { status: "unsupported", reason: `The Claude CLI has no ${names} control; remove it or bind this request to the Ollama Endpoint` };
    }
    return { status: "supported" };
  } catch (error) {
    return { status: "unsupported", reason: (error as Error).message };
  }
}

/** Strip one surrounding Markdown code fence, which chat models often add around JSON. */
function unfence(text: string): string {
  const match = /^```[a-z]*\s*\n([\s\S]*?)\n?```$/iu.exec(text.trim());
  return match === null ? text.trim() : match[1]!.trim();
}

export async function generateClaudeText(
  runner: ClaudeRunner,
  model: string,
  request: TextGenerationRequest,
  context?: Pick<EndpointInvocationContext, "reportProgress" | "reportDiagnostic">,
): Promise<string> {
  const json = request.format === "json";
  const system = [request.system ?? defaultSystem,
    ...(json ? ["Respond with exactly one valid JSON document and nothing else."] : [])].join("\n\n");
  await context?.reportProgress?.({ phase: `Generating text through the Claude CLI with local ${model}` });
  const result = await runner.run({ model, system, prompt: request.prompt });
  const text = json ? unfence(result.text) : result.text.trim();
  if (text.length === 0) throw new ClaudeCliError("CLAUDE_CLI_EMPTY_OUTPUT", `Local model ${model} returned empty text`);
  if (json) {
    try { JSON.parse(text); } catch {
      throw new ClaudeCliError("CLAUDE_CLI_INVALID_JSON_OUTPUT", `Local model ${model} did not return valid JSON`);
    }
  }
  // Counts only: prompts and generated text stay out of diagnostics.
  await context?.reportDiagnostic?.({
    level: "info",
    message: `Claude CLI -> Ollama ${model} at ${runner.ollamaBaseUrl}: ${result.inputTokens ?? "?"} input tokens, `
      + `${result.outputTokens ?? "?"} output tokens, ${result.durationMs ?? "?"} ms`,
  });
  return text;
}

export function createClaudeTextProvider(options: CreateClaudeTextProviderOptions) {
  const model = verifyOllamaModelName(options.model);
  const base = ollamaBaseUrl(options.ollamaBaseUrl ?? ollamaDefaults.baseUrl, options.allowNetworkHost === true);
  const command = options.command ?? findClaudeOnPath();
  if (options.launcher === undefined && command === undefined) {
    throw new Error("The Claude CLI is not on PATH; set command to the absolute path of claude.cmd or the claude executable");
  }
  const launcher = options.launcher ?? { command: resolveClaudeCommand(command!), args: [] };
  const runner = createClaudeRunner({
    launcher, ollamaBaseUrl: base,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
  });
  const instance = options.instance ?? "claude.local";
  const endpoint = defineEndpoint({
    instance,
    pool: options.pool ?? instance,
    // Inference runs in the local Ollama; the CLI is never authorized against Anthropic.
    pricing: { kind: "local" },
    defaultConcurrency: options.defaultConcurrency ?? 1,
    capabilities: [{
      lifecycle: "immediate" as const,
      capability: textGenerationCapabilities.generate,
      returns: textTypes.text,
      supports: claudeTextSupport,
      transient: true,
      handler: async (context: EndpointInvocationContext): Promise<EndpointFulfillment> => {
        const request = verifyTextGenerationRequest(context.need.constraints);
        const support = claudeTextSupport(context.need);
        if (support.status === "unsupported") throw new Error(support.reason);
        const text = await generateClaudeText(runner, model, request, context);
        return { value: { kind: "inline", value: canonicalize(sealText(text)) } };
      },
    }],
  });
  return { endpoint, runner, model };
}
