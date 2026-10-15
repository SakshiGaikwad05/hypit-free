import { canonicalize, defineEndpoint } from "@hypit/hypit/endpoint";
import type { EndpointFulfillment, EndpointInvocationContext, EndpointRequest, EndpointSupport } from "@hypit/hypit/endpoint";
import { sealText, textTypes } from "@hypit/hypit/text";
import {
  textGenerationCapabilities, verifyTextGenerationOptions, verifyTextGenerationRequest,
} from "@local/text-generation";
import type { TextGenerationRequest } from "@local/text-generation";

import {
  createOpenCodeRunner, findOpenCodeOnPath, OpenCodeError, openCodeModelProvider, resolveOpenCodeCommand,
  verifyOpenCodeModel,
} from "./opencode.js";
import type { OpenCodeLauncher, OpenCodeRunner } from "./opencode.js";

export const openCodeProviderModuleRef = { name: "@local/provider-opencode", version: "1" } as const;

/** OpenCode providers whose models run on this machine. */
export const defaultLocalOpenCodeProviders = ["ollama"] as const;

/** Prompt arguments stay well inside the Windows command-line limit. */
export const openCodeMaxPromptCharacters = 24_000;

const defaultSystem = "You are a precise writing assistant for short-form video. Answer the user's request directly "
  + "with the requested text only: no preamble, no quotes, no commentary. You have no tools and must not try to use any.";

export type CreateOpenCodeTextProviderOptions = {
  readonly instance?: string;
  readonly pool?: string;
  /** Absolute path to `opencode.cmd` or the opencode executable. Omitted: found on PATH. */
  readonly command?: string;
  /** Test seam: an explicit launcher instead of resolving `command`. */
  readonly launcher?: OpenCodeLauncher;
  /** OpenCode `provider/model`, e.g. `ollama/qwen2.5:1.5b`. */
  readonly model: string;
  /** Required to use a model whose OpenCode provider is not in `localProviders`. */
  readonly allowHostedModel?: boolean;
  readonly localProviders?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly defaultConcurrency?: number;
};

/** OpenCode's CLI exposes no token-limit or seed control, so those requests are refused, not altered. */
export function openCodeTextSupport(request: EndpointRequest): EndpointSupport {
  try {
    const constraints = request.constraints;
    const complete = constraints !== null && typeof constraints === "object" && !Array.isArray(constraints)
      && "prompt" in constraints;
    const parsed = complete ? verifyTextGenerationRequest(constraints) : verifyTextGenerationOptions(constraints);
    if (parsed.maxTokens !== undefined) {
      return { status: "unsupported", reason: "The OpenCode CLI has no max-tokens control; remove max-tokens or bind this request to the Ollama Endpoint" };
    }
    if (parsed.seed !== undefined) {
      return { status: "unsupported", reason: "The OpenCode CLI has no seed control; remove seed or bind this request to the Ollama Endpoint" };
    }
    if (complete && (parsed as TextGenerationRequest).prompt.length > openCodeMaxPromptCharacters) {
      return { status: "unsupported", reason: `The OpenCode Provider accepts prompts up to ${openCodeMaxPromptCharacters} characters` };
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

export async function generateOpenCodeText(
  runner: OpenCodeRunner,
  model: string,
  request: TextGenerationRequest,
  context?: Pick<EndpointInvocationContext, "reportProgress" | "reportDiagnostic">,
  onlyThisProvider = true,
): Promise<string> {
  const json = request.format === "json";
  const system = [
    request.system ?? defaultSystem,
    ...(json ? ["Respond with exactly one valid JSON document and nothing else."] : []),
  ].join("\n\n");
  await context?.reportProgress?.({ phase: `Generating text through OpenCode with ${model}` });
  const result = await runner.run({
    model, system, prompt: request.prompt, onlyThisProvider,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  });
  const text = json ? unfence(result.text) : result.text.trim();
  if (text.length === 0) throw new OpenCodeError("OPENCODE_EMPTY_OUTPUT", `OpenCode model ${model} returned empty text`);
  if (json) {
    try { JSON.parse(text); } catch {
      throw new OpenCodeError("OPENCODE_INVALID_JSON_OUTPUT", `OpenCode model ${model} did not return valid JSON`);
    }
  }
  // Counts only: prompts and generated text stay out of diagnostics.
  await context?.reportDiagnostic?.({
    level: result.toolAttempts > 0 ? "warning" : "info",
    message: `OpenCode ${model}: ${result.inputTokens ?? "?"} input tokens, ${result.outputTokens ?? "?"} output tokens, `
      + `finish ${result.finishReason ?? "unknown"}`
      + (result.toolAttempts > 0 ? `; ${result.toolAttempts} tool attempt(s) were denied` : ""),
  });
  return text;
}

export function createOpenCodeTextProvider(options: CreateOpenCodeTextProviderOptions) {
  const model = verifyOpenCodeModel(options.model);
  const localProviders = options.localProviders ?? defaultLocalOpenCodeProviders;
  const local = localProviders.includes(openCodeModelProvider(model));
  if (!local && options.allowHostedModel !== true) {
    throw new Error(`OpenCode model ${model} is not served by a local provider (${localProviders.join(", ")}); `
      + "set allowHostedModel only if you accept sending prompts to that hosted service");
  }
  const command = options.command ?? findOpenCodeOnPath();
  if (options.launcher === undefined && command === undefined) {
    throw new Error("OpenCode is not on PATH; set command to the absolute path of opencode.cmd or the opencode executable");
  }
  const launcher = options.launcher ?? { command: resolveOpenCodeCommand(command!), args: [] };
  const runner = createOpenCodeRunner({
    launcher,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
  });
  const instance = options.instance ?? "opencode.local";
  const endpoint = defineEndpoint({
    instance,
    pool: options.pool ?? instance,
    // Local models carry no Provider charge; a hosted route's pricing is unknown here.
    ...(local ? { pricing: { kind: "local" as const } } : {}),
    defaultConcurrency: options.defaultConcurrency ?? 1,
    capabilities: [{
      lifecycle: "immediate" as const,
      capability: textGenerationCapabilities.generate,
      returns: textTypes.text,
      supports: openCodeTextSupport,
      ...(local ? { transient: true as const } : {}),
      handler: async (context: EndpointInvocationContext): Promise<EndpointFulfillment> => {
        const request = verifyTextGenerationRequest(context.need.constraints);
        const support = openCodeTextSupport(context.need);
        if (support.status === "unsupported") throw new Error(support.reason);
        // A local route is confined to its own provider; an opted-in hosted route keeps OpenCode's defaults.
        const text = await generateOpenCodeText(runner, model, request, context, local);
        return { value: { kind: "inline", value: canonicalize(sealText(text)) } };
      },
    }],
  });
  return { endpoint, runner, model, local };
}
