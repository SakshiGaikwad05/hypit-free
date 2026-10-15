import {
  createRuntimeEndpointAdapterFacet, runtimeConfigBoolean, runtimeConfigExact,
  runtimeConfigObject, runtimeConfigPositiveInteger, runtimeConfigString,
} from "@hypit/runtime-local/extension";

import { claudeCliProgram, diagnoseClaudeCli } from "./program.js";
import { claudeProviderModuleRef, createClaudeTextProvider } from "./provider.js";

export const claudeRuntimeAdapter = createRuntimeEndpointAdapterFacet({
  use: claudeProviderModuleRef.name,
  activate(context) {
    const config = runtimeConfigObject(context.config, "Claude CLI");
    runtimeConfigExact(config, [
      "command", "model", "ollamaBaseUrl", "allowNetworkHost",
      "requestTimeoutMs", "maxOutputBytes", "defaultConcurrency",
    ], "Claude CLI");
    const model = runtimeConfigString(config.model, "Claude CLI model");
    if (model === undefined) throw new Error("Claude CLI Endpoint requires config.model, an Ollama tag such as \"qwen2.5:1.5b\"");
    const command = runtimeConfigString(config.command, "Claude CLI command");
    const ollamaBaseUrl = runtimeConfigString(config.ollamaBaseUrl, "Claude CLI ollamaBaseUrl");
    const allowNetworkHost = runtimeConfigBoolean(config.allowNetworkHost, "Claude CLI allowNetworkHost");
    const requestTimeoutMs = runtimeConfigPositiveInteger(config.requestTimeoutMs, "Claude CLI requestTimeoutMs");
    const maxOutputBytes = runtimeConfigPositiveInteger(config.maxOutputBytes, "Claude CLI maxOutputBytes");
    const defaultConcurrency = runtimeConfigPositiveInteger(config.defaultConcurrency, "Claude CLI defaultConcurrency");
    const { endpoint, runner } = createClaudeTextProvider({
      instance: context.instance,
      pool: context.pool ?? context.instance,
      model,
      ...(command === undefined ? {} : { command }),
      ...(ollamaBaseUrl === undefined ? {} : { ollamaBaseUrl }),
      ...(allowNetworkHost === undefined ? {} : { allowNetworkHost }),
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
      ...(defaultConcurrency === undefined ? {} : { defaultConcurrency }),
    });
    return {
      endpoint,
      program: claudeCliProgram(context.instance, runner, model),
      diagnose: () => diagnoseClaudeCli(runner, model),
    };
  },
});

export const hypitPackage = {
  format: "hypit.package@1" as const,
  facets: [claudeRuntimeAdapter],
};
export default hypitPackage;
