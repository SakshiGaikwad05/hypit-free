/**
 * Opt-in: drives the real OpenCode CLI against a real local Ollama model. Never pulls models.
 *
 *   ollama pull qwen2.5:1.5b
 *   pnpm test:ollama            (opencode must be on PATH, or set HYPIT_OPENCODE_COMMAND)
 *
 * HYPIT_OPENCODE_MODEL overrides the default `ollama/qwen2.5:1.5b`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createOpenCodeTextProvider, findOpenCodeOnPath, generateOpenCodeText, probeOpenCode } from "../src/index.js";

const command = process.env.HYPIT_OPENCODE_COMMAND ?? findOpenCodeOnPath();
const model = process.env.HYPIT_OPENCODE_MODEL ?? "ollama/qwen2.5:1.5b";
const skip = process.env.HYPIT_OLLAMA_TESTS === "1" && command !== undefined
  ? false
  : "set HYPIT_OLLAMA_TESTS=1 with OpenCode on PATH, Ollama running and the model pulled";

test("OpenCode, the configured local model and Ollama are ready", { skip }, async () => {
  const { runner } = createOpenCodeTextProvider({ command: command!, model });
  const state = await probeOpenCode(runner, model);
  assert.equal(state.state, "ready", "detail" in state ? state.detail : undefined);
});

test("OpenCode returns local text and valid JSON without tools", { skip, timeout: 900_000 }, async () => {
  const { runner } = createOpenCodeTextProvider({ command: command!, model });
  const hook = await generateOpenCodeText(runner, model, {
    format: "text", temperature: 0.7,
    prompt: "Write one scroll-stopping opening line for a video about cold brew coffee.",
  });
  assert.ok(hook.length > 0 && hook.length < 800, hook);
  const json = await generateOpenCodeText(runner, model, {
    format: "json", temperature: 0,
    prompt: "Return JSON {\"hooks\": [string, string, string]} with three short video hooks about cold brew coffee.",
  });
  assert.ok(Array.isArray((JSON.parse(json) as { hooks?: unknown }).hooks), json);
});
