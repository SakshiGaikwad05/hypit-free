/**
 * Opt-in: drives the real Claude CLI against a real local Ollama model. Never pulls models, and
 * never authenticates with Anthropic (the CLI runs with --bare against ANTHROPIC_BASE_URL=Ollama).
 *
 *   ollama pull qwen2.5:1.5b
 *   pnpm test:ollama            (claude must be on PATH, or set HYPIT_CLAUDE_COMMAND)
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createClaudeTextProvider, findClaudeOnPath, generateClaudeText, probeClaudeCli } from "../src/index.js";

const command = process.env.HYPIT_CLAUDE_COMMAND ?? findClaudeOnPath();
const model = process.env.HYPIT_OLLAMA_MODEL ?? "qwen2.5:1.5b";
const ollamaBaseUrl = process.env.HYPIT_OLLAMA_URL ?? "http://127.0.0.1:11434";
const skip = process.env.HYPIT_OLLAMA_TESTS === "1" && command !== undefined
  ? false
  : "set HYPIT_OLLAMA_TESTS=1 with the Claude CLI on PATH, Ollama running and the model pulled";

test("the Claude CLI and the local model are ready", { skip }, async () => {
  const { runner } = createClaudeTextProvider({ command: command!, model, ollamaBaseUrl });
  const state = await probeClaudeCli(runner, model);
  assert.equal(state.state, "ready", "detail" in state ? state.detail : undefined);
});

test("the Claude CLI returns local text and valid JSON", { skip, timeout: 900_000 }, async () => {
  const { runner } = createClaudeTextProvider({ command: command!, model, ollamaBaseUrl });
  const hook = await generateClaudeText(runner, model, {
    format: "text", prompt: "Write one scroll-stopping opening line for a video about cold brew coffee.",
  });
  assert.ok(hook.length > 0 && hook.length < 800, hook);
  const json = await generateClaudeText(runner, model, {
    format: "json", prompt: "Return JSON {\"hooks\": [string, string, string]} with three short video hooks about cold brew coffee.",
  });
  assert.ok(Array.isArray((JSON.parse(json) as { hooks?: unknown }).hooks), json);
});
