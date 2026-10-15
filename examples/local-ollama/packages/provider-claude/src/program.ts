import type { ManagedProgram, ManagedProgramState, RuntimeDoctorDiagnostic } from "@hypit/runtime-local/extension";
import { createOllamaClient, probeOllama } from "@local/provider-ollama";

import { ClaudeCliError } from "./claude.js";
import type { ClaudeRunner } from "./claude.js";

/** Read-only readiness: the CLI starts and the local Ollama serves the model. Nothing is pulled. */
export async function probeClaudeCli(runner: ClaudeRunner, model: string): Promise<ManagedProgramState> {
  try {
    await runner.version();
  } catch (error) {
    return { state: "down", detail: error instanceof ClaudeCliError ? error.message : "The Claude CLI did not start" };
  }
  return probeOllama(createOllamaClient({ baseUrl: runner.ollamaBaseUrl, allowNetworkHost: true }), model);
}

export function claudeCliProgram(id: string, runner: ClaudeRunner, model: string): ManagedProgram {
  return { id, probe: () => probeClaudeCli(runner, model) };
}

export async function diagnoseClaudeCli(runner: ClaudeRunner, model: string): Promise<readonly RuntimeDoctorDiagnostic[]> {
  const state = await probeClaudeCli(runner, model);
  if (state.state === "ready") {
    return [{ severity: "info", code: "CLAUDE_CLI_READY",
      message: `Claude CLI (${runner.launcher.command}) runs ${model} on Ollama at ${runner.ollamaBaseUrl}`, subject: model }];
  }
  const ollama = /Ollama/u.test(state.detail);
  const code = state.state === "down"
    ? ollama ? "OLLAMA_UNAVAILABLE" : "CLAUDE_CLI_UNAVAILABLE"
    : "OLLAMA_MODEL_NOT_FOUND";
  return [{ severity: "error", code, message: state.detail, subject: model }];
}
