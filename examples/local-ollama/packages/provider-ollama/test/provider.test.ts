import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { EndpointRegistry, MemoryResourceStore } from "@hypit/executor";
import { canonicalize } from "@hypit/hypit/endpoint";
import type { EndpointInvocationContext } from "@hypit/hypit/endpoint";
import { textTypes } from "@hypit/hypit/text";
import { sealTextGenerationRequest, textGenerationCapabilities } from "@local/text-generation";
import type { TextGenerationRequest } from "@local/text-generation";

import hypitPackage from "../src/activation.js";
import { createOllamaTextProvider, ollamaBaseUrl, OllamaError, probeOllama } from "../src/index.js";
// The same loopback mock backs the documented end-to-end check; it runs no model.
import { startMockOllama } from "../../../scripts/mock-ollama.mjs";

const mock = (options: { models?: string[]; behavior?: string } = {}) => startMockOllama(options);

function need(request: TextGenerationRequest) {
  return {
    id: "need:text", capability: textGenerationCapabilities.generate, returns: textTypes.text,
    constraints: canonicalize(sealTextGenerationRequest(request)), result: "record:text",
  } as const;
}

async function invoke(provider: ReturnType<typeof createOllamaTextProvider>, request: TextGenerationRequest, observed?: {
  progress: string[]; diagnostics: string[];
}) {
  const registry = new EndpointRegistry();
  await provider.endpoint.install(registry);
  const item = need(request);
  const resolved = registry.resolve(item);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.registration.kind, "immediate");
  const context: EndpointInvocationContext = {
    need: item, command: { kind: "fulfill-need", id: "command:text", need: item },
    resources: new MemoryResourceStore(), credentials: {},
    reportProgress: async (value) => { observed?.progress.push(value.phase); },
    reportDiagnostic: async (value) => { observed?.diagnostics.push(value.message); },
  };
  const result = await resolved.registration.handler(context);
  assert.equal(result.value.kind, "inline");
  return (result.value.value as unknown as { value: string }).value;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("maps a request to one local /api/chat call with the Profile-selected model and returns Text", async () => {
  const service = await mock({ models: ["qwen2.5:1.5b"] });
  try {
    const provider = createOllamaTextProvider({ model: "qwen2.5:1.5b", baseUrl: service.baseUrl, contextTokens: 2048, keepAlive: "5m" });
    const observed = { progress: [] as string[], diagnostics: [] as string[] };
    const prompt = "SECRET-PROMPT write a hook about cold brew";
    const text = await invoke(provider, {
      format: "text", prompt, system: "You write short video hooks.", temperature: 0.7, maxTokens: 64, seed: 3,
    }, observed);
    assert.equal(text, `Mock qwen2.5:1.5b reply (${prompt.length} prompt characters).`);
    const chats = service.state.requests.filter((item) => item.path === "/api/chat");
    assert.equal(chats.length, 1);
    assert.deepEqual(chats[0]!.body, {
      model: "qwen2.5:1.5b",
      messages: [{ role: "system", content: "You write short video hooks." }, { role: "user", content: prompt }],
      stream: false,
      options: { temperature: 0.7, num_predict: 64, seed: 3, num_ctx: 2048 },
      keep_alive: "5m",
    });
    assert.deepEqual(observed.progress, ["Generating text locally with qwen2.5:1.5b"]);
    assert.equal(observed.diagnostics.length, 1);
    assert.match(observed.diagnostics[0]!, /12 prompt tokens, 8 output tokens/u);
    // Prompts and outputs never enter diagnostics.
    assert.doesNotMatch(observed.diagnostics.join("\n"), /SECRET-PROMPT|Mock qwen/u);
    assert.equal(provider.endpoint.pricing?.kind, "local");
    assert.equal(provider.endpoint.credentials.length, 0);
    assert.equal(provider.endpoint.offers[0]?.transient, true);
  } finally {
    await service.close();
  }
});

test("JSON format asks Ollama for JSON and publishes it only when it parses", async () => {
  const service = await mock();
  try {
    const provider = createOllamaTextProvider({ model: "qwen2.5:1.5b", baseUrl: service.baseUrl });
    const text = await invoke(provider, { format: "json", prompt: "Three hooks as JSON" });
    assert.deepEqual(JSON.parse(text).hooks, ["Mock hook one", "Mock hook two"]);
    assert.equal(service.state.requests.at(-1)?.body?.format, "json");
    service.state.behavior = "bad-json-output";
    await assert.rejects(invoke(provider, { format: "json", prompt: "Three hooks as JSON" }),
      (error: OllamaError) => error.code === "OLLAMA_INVALID_JSON_OUTPUT");
  } finally {
    await service.close();
  }
});

test("a missing model fails with a pull instruction after exactly one request, never another route", async () => {
  const service = await mock({ models: ["llama3.2:1b"] });
  try {
    const provider = createOllamaTextProvider({ model: "qwen2.5:1.5b", baseUrl: service.baseUrl });
    await assert.rejects(invoke(provider, { format: "text", prompt: "hello" }), (error: OllamaError) => {
      assert.equal(error.code, "OLLAMA_MODEL_NOT_FOUND");
      assert.match(error.message, /ollama pull qwen2\.5:1\.5b/u);
      return true;
    });
    assert.deepEqual(service.state.requests.map((item) => item.path), ["/api/chat"]);
  } finally {
    await service.close();
  }
});

test("an unavailable service, a timeout and broken responses fail with distinct codes", async () => {
  const unavailable = createOllamaTextProvider({ model: "qwen2.5:1.5b", baseUrl: `http://127.0.0.1:${await closedPort()}` });
  await assert.rejects(invoke(unavailable, { format: "text", prompt: "hello" }), (error: OllamaError) => {
    assert.equal(error.code, "OLLAMA_UNAVAILABLE");
    assert.match(error.message, /ollama serve/u);
    return true;
  });
  const service = await mock();
  try {
    const cases: [string, string, number?][] = [
      ["hang", "OLLAMA_TIMEOUT", 200],
      ["malformed", "OLLAMA_MALFORMED_RESPONSE"],
      ["not-json", "OLLAMA_MALFORMED_RESPONSE"],
      ["empty", "OLLAMA_EMPTY_OUTPUT"],
      ["error-500", "OLLAMA_HTTP_ERROR"],
      ["huge", "OLLAMA_RESPONSE_TOO_LARGE"],
    ];
    for (const [behavior, code, requestTimeoutMs] of cases) {
      service.state.behavior = behavior;
      const provider = createOllamaTextProvider({
        model: "qwen2.5:1.5b", baseUrl: service.baseUrl, maxResponseBytes: 1024 * 1024,
        ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      });
      await assert.rejects(invoke(provider, { format: "text", prompt: "hello" }),
        (error: OllamaError) => { assert.equal(error.code, code, behavior); return true; });
    }
  } finally {
    await service.close();
  }
});

test("invalid requests and configuration are refused before contacting the service", async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls += 1; throw new Error("must not be called"); };
  const provider = createOllamaTextProvider({ model: "qwen2.5:1.5b", fetch });
  const support = provider.endpoint.offers[0]!.supports!;
  const request = { capability: textGenerationCapabilities.generate, returns: textTypes.text };
  assert.equal(support({ ...request, constraints: { format: "text", temperature: 3 } }).status, "unsupported");
  assert.equal(support({ ...request, constraints: { format: "text", prompt: "  " } }).status, "unsupported");
  assert.equal(support({ ...request, constraints: { format: "yaml" } }).status, "unsupported");
  assert.equal(support({ ...request, constraints: { format: "json", maxTokens: 128 } }).status, "supported");
  assert.throws(() => sealTextGenerationRequest({ format: "text", prompt: "" }), /prompt is empty/u);
  assert.throws(() => createOllamaTextProvider({ model: "bad model name!" }), /Ollama model tag/u);
  assert.throws(() => createOllamaTextProvider({ model: "qwen2.5:1.5b", keepAlive: "forever" }), /keepAlive/u);
  assert.throws(() => ollamaBaseUrl("http://192.168.1.20:11434"), /not loopback/u);
  assert.equal(ollamaBaseUrl("http://192.168.1.20:11434/", true), "http://192.168.1.20:11434");
  assert.throws(() => ollamaBaseUrl("http://user:pass@127.0.0.1:11434"), /credentials/u);
  assert.equal(calls, 0);
});

test("Profile activation validates config, and the probe reports readiness without downloading", async () => {
  const facet = hypitPackage.facets[0]!;
  const activate = (config: Record<string, unknown>) => (facet.implementation as {
    activate(context: unknown): { endpoint: { instance: { id: string } }; program?: { probe(): Promise<{ state: string; detail?: string }> } };
  }).activate({ hostStateRoot: "/tmp/host", dataRoot: "/tmp/data", instance: "ollama.local", config });
  assert.throws(() => activate({}), /requires config\.model/u);
  assert.throws(() => activate({ model: "qwen2.5:1.5b", apiKey: "x" }), /apiKey/u);
  assert.throws(() => activate({ model: "qwen2.5:1.5b", baseUrl: "http://10.0.0.5:11434" }), /not loopback/u);
  const service = await mock({ models: ["qwen2.5:1.5b"] });
  try {
    const ready = activate({ model: "qwen2.5:1.5b", baseUrl: service.baseUrl });
    assert.equal(ready.endpoint.instance.id, "ollama.local");
    assert.deepEqual(await ready.program!.probe(), { state: "ready" });
    const missing = await activate({ model: "llama3.2:3b", baseUrl: service.baseUrl }).program!.probe();
    assert.equal(missing.state, "mismatch");
    assert.match(missing.detail!, /ollama pull llama3\.2:3b/u);
    assert.ok(service.state.requests.every((item) => item.method === "GET"), "probing never posts or pulls");
  } finally {
    await service.close();
  }
  const down = createOllamaTextProvider({ model: "qwen2.5:1.5b", baseUrl: `http://127.0.0.1:${await closedPort()}` });
  assert.equal((await probeOllama(down.client, "qwen2.5:1.5b")).state, "down");
});
