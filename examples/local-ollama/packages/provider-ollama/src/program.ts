import type { ManagedProgram, ManagedProgramState, RuntimeDoctorDiagnostic } from "@hypit/runtime-local/extension";

import { OllamaError, ollamaModelInstalled } from "./ollama.js";
import type { OllamaClient } from "./ollama.js";

/**
 * Read-only readiness for an Ollama service this Runtime does not own. It never starts Ollama and
 * never pulls a model: both are explicit user actions because they cost time, disk and memory.
 */
export async function probeOllama(client: OllamaClient, model: string): Promise<ManagedProgramState> {
  let installed: readonly string[];
  try {
    await client.version();
    installed = await client.models();
  } catch (error) {
    return { state: "down", detail: error instanceof OllamaError ? error.message : `Ollama probe failed at ${client.baseUrl}` };
  }
  if (!ollamaModelInstalled(installed, model)) {
    return { state: "mismatch", detail: `Ollama is running at ${client.baseUrl} but model ${model} is not installed. Run \`ollama pull ${model}\`.` };
  }
  return { state: "ready" };
}

export function ollamaProgram(id: string, client: OllamaClient, model: string): ManagedProgram {
  return { id, probe: () => probeOllama(client, model) };
}

export async function diagnoseOllama(client: OllamaClient, model: string): Promise<readonly RuntimeDoctorDiagnostic[]> {
  const state = await probeOllama(client, model);
  if (state.state === "ready") {
    return [{ severity: "info", code: "OLLAMA_READY", message: `Ollama at ${client.baseUrl} serves ${model}`, subject: model }];
  }
  return [{
    severity: "error",
    code: state.state === "down" ? "OLLAMA_UNAVAILABLE" : "OLLAMA_MODEL_NOT_FOUND",
    message: state.detail,
    subject: model,
  }];
}
