import type { ManagedProgram, ManagedProgramState, RuntimeDoctorDiagnostic } from "@hypit/runtime-local/extension";
import { createOllamaClient, probeOllama } from "@local/provider-ollama";

import { OpenCodeError } from "./opencode.js";
import type { OpenCodeRunner } from "./opencode.js";

/**
 * Read-only readiness: the CLI starts, knows the model, and, for `ollama/*`, Ollama serves it.
 * Nothing is started, installed or pulled.
 */
export async function probeOpenCode(runner: OpenCodeRunner, model: string, ollamaBaseUrl?: string): Promise<ManagedProgramState> {
  let models: readonly string[];
  try {
    await runner.version();
    models = await runner.models();
  } catch (error) {
    return { state: "down", detail: error instanceof OpenCodeError ? error.message : "OpenCode CLI did not start" };
  }
  if (!models.includes(model)) {
    return { state: "mismatch", detail: `OpenCode does not list ${model}; add it to opencode.jsonc (see \`opencode models\`)` };
  }
  if (model.startsWith("ollama/")) {
    const state = await probeOllama(createOllamaClient(ollamaBaseUrl === undefined ? {} : { baseUrl: ollamaBaseUrl }), model.slice(7));
    if (state.state !== "ready") return state;
  }
  return { state: "ready" };
}

export function openCodeProgram(id: string, runner: OpenCodeRunner, model: string, ollamaBaseUrl?: string): ManagedProgram {
  return { id, probe: () => probeOpenCode(runner, model, ollamaBaseUrl) };
}

export async function diagnoseOpenCode(runner: OpenCodeRunner, model: string, ollamaBaseUrl?: string): Promise<readonly RuntimeDoctorDiagnostic[]> {
  const state = await probeOpenCode(runner, model, ollamaBaseUrl);
  if (state.state === "ready") {
    return [{ severity: "info", code: "OPENCODE_READY", message: `OpenCode (${runner.launcher.command}) serves ${model}`, subject: model }];
  }
  const ollama = /Ollama/u.test(state.detail);
  const code = state.state === "down"
    ? ollama ? "OLLAMA_UNAVAILABLE" : "OPENCODE_UNAVAILABLE"
    : ollama ? "OLLAMA_MODEL_NOT_FOUND" : "OPENCODE_MODEL_NOT_LISTED";
  return [{ severity: "error", code, message: state.detail, subject: model }];
}
