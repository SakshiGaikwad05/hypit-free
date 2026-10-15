import {
  createRuntimeEndpointAdapterFacet, runtimeConfigBoolean, runtimeConfigExact,
  runtimeConfigObject, runtimeConfigPositiveInteger, runtimeConfigString,
} from "@hypit/runtime-local/extension";

import { ollamaBaseUrl, ollamaDefaults } from "./ollama.js";
import { diagnoseOllama, ollamaProgram } from "./program.js";
import { createOllamaTextProvider, ollamaProviderModuleRef } from "./provider.js";

export const ollamaRuntimeAdapter = createRuntimeEndpointAdapterFacet({
  use: ollamaProviderModuleRef.name,
  activate(context) {
    const config = runtimeConfigObject(context.config, "Ollama");
    runtimeConfigExact(config, [
      "baseUrl", "model", "allowNetworkHost", "requestTimeoutMs", "maxResponseBytes",
      "keepAlive", "contextTokens", "defaultConcurrency",
    ], "Ollama");
    const model = runtimeConfigString(config.model, "Ollama model");
    if (model === undefined) throw new Error("Ollama Endpoint requires config.model, e.g. \"qwen2.5:1.5b\"");
    const allowNetworkHost = runtimeConfigBoolean(config.allowNetworkHost, "Ollama allowNetworkHost");
    const baseUrl = ollamaBaseUrl(runtimeConfigString(config.baseUrl, "Ollama baseUrl") ?? ollamaDefaults.baseUrl,
      allowNetworkHost === true);
    const requestTimeoutMs = runtimeConfigPositiveInteger(config.requestTimeoutMs, "Ollama requestTimeoutMs");
    const maxResponseBytes = runtimeConfigPositiveInteger(config.maxResponseBytes, "Ollama maxResponseBytes");
    const keepAlive = runtimeConfigString(config.keepAlive, "Ollama keepAlive");
    const contextTokens = runtimeConfigPositiveInteger(config.contextTokens, "Ollama contextTokens");
    const defaultConcurrency = runtimeConfigPositiveInteger(config.defaultConcurrency, "Ollama defaultConcurrency");
    const { endpoint, client } = createOllamaTextProvider({
      instance: context.instance,
      pool: context.pool ?? context.instance,
      model,
      baseUrl,
      ...(allowNetworkHost === undefined ? {} : { allowNetworkHost }),
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
      ...(keepAlive === undefined ? {} : { keepAlive }),
      ...(contextTokens === undefined ? {} : { contextTokens }),
      ...(defaultConcurrency === undefined ? {} : { defaultConcurrency }),
    });
    return {
      endpoint,
      program: ollamaProgram(context.instance, client, model),
      diagnose: () => diagnoseOllama(client, model),
    };
  },
});

export const hypitPackage = {
  format: "hypit.package@1" as const,
  facets: [ollamaRuntimeAdapter],
};
export default hypitPackage;
