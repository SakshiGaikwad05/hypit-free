import {
  createRuntimeEndpointAdapterFacet, runtimeConfigBoolean, runtimeConfigExact,
  runtimeConfigObject, runtimeConfigPositiveInteger, runtimeConfigString,
} from "@hypit/runtime-local/extension";
import { ollamaBaseUrl as verifyOllamaBaseUrl } from "@local/provider-ollama";

import { diagnoseOpenCode, openCodeProgram } from "./program.js";
import { createOpenCodeTextProvider, openCodeProviderModuleRef } from "./provider.js";

export const openCodeRuntimeAdapter = createRuntimeEndpointAdapterFacet({
  use: openCodeProviderModuleRef.name,
  activate(context) {
    const config = runtimeConfigObject(context.config, "OpenCode");
    runtimeConfigExact(config, [
      "command", "model", "allowHostedModel", "localProviders", "ollamaBaseUrl",
      "requestTimeoutMs", "maxOutputBytes", "defaultConcurrency",
    ], "OpenCode");
    const command = runtimeConfigString(config.command, "OpenCode command");
    const model = runtimeConfigString(config.model, "OpenCode model");
    if (model === undefined) throw new Error("OpenCode Endpoint requires config.model, e.g. \"ollama/qwen2.5:1.5b\"");
    const localProviders = config.localProviders;
    if (localProviders !== undefined && (!Array.isArray(localProviders)
      || localProviders.some((item) => typeof item !== "string" || !/^[a-z0-9._-]+$/iu.test(item)))) {
      throw new Error("OpenCode localProviders must be an array of provider ids, e.g. [\"ollama\"]");
    }
    const allowHostedModel = runtimeConfigBoolean(config.allowHostedModel, "OpenCode allowHostedModel");
    const ollamaBaseUrlValue = runtimeConfigString(config.ollamaBaseUrl, "OpenCode ollamaBaseUrl");
    const ollamaBaseUrl = ollamaBaseUrlValue === undefined ? undefined : verifyOllamaBaseUrl(ollamaBaseUrlValue);
    const requestTimeoutMs = runtimeConfigPositiveInteger(config.requestTimeoutMs, "OpenCode requestTimeoutMs");
    const maxOutputBytes = runtimeConfigPositiveInteger(config.maxOutputBytes, "OpenCode maxOutputBytes");
    const defaultConcurrency = runtimeConfigPositiveInteger(config.defaultConcurrency, "OpenCode defaultConcurrency");
    const { endpoint, runner } = createOpenCodeTextProvider({
      instance: context.instance,
      pool: context.pool ?? context.instance,
      ...(command === undefined ? {} : { command }),
      model,
      ...(allowHostedModel === undefined ? {} : { allowHostedModel }),
      ...(localProviders === undefined ? {} : { localProviders: localProviders as string[] }),
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
      ...(defaultConcurrency === undefined ? {} : { defaultConcurrency }),
    });
    return {
      endpoint,
      program: openCodeProgram(context.instance, runner, model, ollamaBaseUrl),
      diagnose: () => diagnoseOpenCode(runner, model, ollamaBaseUrl),
    };
  },
});

export const hypitPackage = {
  format: "hypit.package@1" as const,
  facets: [openCodeRuntimeAdapter],
};
export default hypitPackage;
