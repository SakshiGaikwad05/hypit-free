/**
 * Opt-in: talks to a real local Ollama. It never pulls a model; install one first.
 *
 *   ollama pull qwen2.5:1.5b
 *   pnpm test:ollama            (sets HYPIT_OLLAMA_TESTS=1)
 *
 * HYPIT_OLLAMA_URL and HYPIT_OLLAMA_MODEL override the defaults.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createOllamaTextProvider, probeOllama } from "../src/index.js";
import { generateOllamaText } from "../src/provider.js";

const enabled = process.env.HYPIT_OLLAMA_TESTS === "1";
const baseUrl = process.env.HYPIT_OLLAMA_URL ?? "http://127.0.0.1:11434";
const model = process.env.HYPIT_OLLAMA_MODEL ?? "qwen2.5:1.5b";
const skip = enabled ? false : "set HYPIT_OLLAMA_TESTS=1 with Ollama running and the model pulled";

test("the configured local model is installed and ready", { skip }, async () => {
  const { client } = createOllamaTextProvider({ model, baseUrl });
  const state = await probeOllama(client, model);
  assert.equal(state.state, "ready", "detail" in state ? state.detail : undefined);
});

test("local text and JSON generation return usable content", { skip, timeout: 600_000 }, async () => {
  const { client } = createOllamaTextProvider({ model, baseUrl, contextTokens: 2048 });
  const settings = { model, contextTokens: 2048 };
  const hook = await generateOllamaText(client, settings, {
    format: "text", temperature: 0.7, maxTokens: 60, seed: 1,
    system: "Reply with one short line only.",
    prompt: "Write a scroll-stopping opening line for a video about cold brew coffee.",
  });
  assert.ok(hook.length > 0 && hook.length < 600, hook);
  const json = await generateOllamaText(client, settings, {
    format: "json", temperature: 0, maxTokens: 300, seed: 1,
    prompt: "Return JSON {\"hooks\": [string, string, string]} with three short video hooks about cold brew coffee.",
  });
  const parsed = JSON.parse(json) as { hooks?: unknown };
  assert.ok(Array.isArray(parsed.hooks), json);
});
