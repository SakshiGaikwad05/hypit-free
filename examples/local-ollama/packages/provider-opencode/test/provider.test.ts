import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EndpointRegistry, MemoryResourceStore } from "@hypit/executor";
import { canonicalize } from "@hypit/hypit/endpoint";
import type { EndpointInvocationContext } from "@hypit/hypit/endpoint";
import { textTypes } from "@hypit/hypit/text";
import { sealTextGenerationRequest, textGenerationCapabilities } from "@local/text-generation";
import type { TextGenerationRequest } from "@local/text-generation";

import hypitPackage from "../src/activation.js";
import { createOpenCodeTextProvider, findOpenCodeOnPath, OpenCodeError, parseOpenCodeEvents } from "../src/index.js";

const fake = fileURLToPath(new URL("./fixtures/fake-opencode.mjs", import.meta.url));
const launcher = { command: process.execPath, args: [fake] };

async function withBehavior<T>(behavior: string, action: (record: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "hypit-fake-opencode-"));
  const record = join(directory, "calls.jsonl");
  process.env.FAKE_OPENCODE_BEHAVIOR = behavior;
  process.env.FAKE_OPENCODE_RECORD = record;
  try {
    return await action(record);
  } finally {
    delete process.env.FAKE_OPENCODE_BEHAVIOR;
    delete process.env.FAKE_OPENCODE_RECORD;
    await rm(directory, { recursive: true, force: true });
  }
}

async function calls(record: string): Promise<{ args: string[]; cwd: string; config: string | null }[]> {
  return (await readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

async function invoke(provider: ReturnType<typeof createOpenCodeTextProvider>, request: TextGenerationRequest, diagnostics: string[] = []) {
  const registry = new EndpointRegistry();
  await provider.endpoint.install(registry);
  const need = {
    id: "need:text", capability: textGenerationCapabilities.generate, returns: textTypes.text,
    constraints: canonicalize(sealTextGenerationRequest(request)), result: "record:text",
  } as const;
  const resolved = registry.resolve(need);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.registration.kind, "immediate");
  const context: EndpointInvocationContext = {
    need, command: { kind: "fulfill-need", id: "command:text", need },
    resources: new MemoryResourceStore(), credentials: {},
    reportDiagnostic: async (value) => { diagnostics.push(value.message); },
  };
  const result = await resolved.registration.handler(context);
  assert.equal(result.value.kind, "inline");
  return (result.value.value as unknown as { value: string }).value;
}

test("runs OpenCode once, without a shell, in an empty directory with a tool-less injected agent", async () => {
  await withBehavior("ok", async (record) => {
    const provider = createOpenCodeTextProvider({ model: "ollama/qwen2.5:1.5b", launcher });
    const diagnostics: string[] = [];
    const prompt = "SECRET-PROMPT -- write a hook; with \"quotes\" & symbols";
    const text = await invoke(provider, { format: "text", prompt, system: "House style.", temperature: 0.4 }, diagnostics);
    assert.equal(text, `Fake reply (${prompt.length} prompt characters).`);
    const [call] = await calls(record);
    assert.deepEqual(call!.args.slice(0, 9), ["run", "--pure", "--format", "json", "--agent", "hypit-text", "-m", "ollama/qwen2.5:1.5b", "--dir"]);
    assert.deepEqual(call!.args.slice(10), ["--", prompt], "the prompt reaches OpenCode as one unaltered argument");
    assert.match(call!.cwd, /hypit-opencode-/u);
    const injected = JSON.parse(call!.config!);
    assert.deepEqual(injected.enabled_providers, ["ollama"], "a local route cannot reach hosted providers");
    assert.equal(injected.small_model, "ollama/qwen2.5:1.5b");
    assert.equal(injected.share, "disabled");
    const agent = injected.agent["hypit-text"];
    assert.deepEqual(agent.permission, { "*": "deny" });
    assert.equal(agent.temperature, 0.4);
    assert.equal(agent.prompt, "House style.");
    assert.match(diagnostics[0]!, /40 input tokens, 9 output tokens, finish stop/u);
    assert.doesNotMatch(diagnostics.join("\n"), /SECRET-PROMPT|Fake reply/u);
    assert.equal(provider.endpoint.pricing?.kind, "local");
    assert.equal(provider.endpoint.offers[0]?.transient, true);
  });
});

test("JSON requests unwrap a code fence, validate the document and refuse invalid JSON", async () => {
  const provider = createOpenCodeTextProvider({ model: "ollama/qwen2.5:1.5b", launcher });
  await withBehavior("fenced-json", async (record) => {
    assert.deepEqual(JSON.parse(await invoke(provider, { format: "json", prompt: "hooks" })), { hooks: ["a", "b"] });
    assert.match(JSON.parse((await calls(record))[0]!.config!).agent["hypit-text"].prompt, /exactly one valid JSON document/u);
  });
  await withBehavior("bad-json", async () => {
    await assert.rejects(invoke(provider, { format: "json", prompt: "hooks" }),
      (error: OpenCodeError) => error.code === "OPENCODE_INVALID_JSON_OUTPUT");
  });
});

test("OpenCode failures keep distinct codes and never retry another model", async () => {
  const cases: [string, string, number?][] = [
    ["free-tier", "OPENCODE_HOSTED_REFUSED"],
    ["model-missing", "OPENCODE_MODEL_NOT_FOUND"],
    ["backend-down", "OPENCODE_BACKEND_UNAVAILABLE"],
    ["crash", "OPENCODE_FAILED"],
    ["empty", "OPENCODE_EMPTY_OUTPUT"],
    ["hang", "OPENCODE_TIMEOUT", 1500],
  ];
  for (const [behavior, code, requestTimeoutMs] of cases) {
    await withBehavior(behavior, async (record) => {
      const provider = createOpenCodeTextProvider({
        model: "ollama/qwen2.5:1.5b", launcher, ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      });
      await assert.rejects(invoke(provider, { format: "text", prompt: "hello" }),
        (error: OpenCodeError) => { assert.equal(error.code, code, behavior); return true; });
      assert.equal((await calls(record)).length, 1, `${behavior}: exactly one OpenCode run`);
    });
  }
  const missing = createOpenCodeTextProvider({ model: "ollama/qwen2.5:1.5b", launcher: { command: join(tmpdir(), "no-such-opencode.exe"), args: [] } });
  await assert.rejects(invoke(missing, { format: "text", prompt: "hello" }), (error: OpenCodeError) => error.code === "OPENCODE_NOT_FOUND");
});

test("denied tool attempts are reported, and only the final assistant message is published", async () => {
  await withBehavior("tool-then-answer", async () => {
    const provider = createOpenCodeTextProvider({ model: "ollama/qwen2.5:1.5b", launcher });
    const diagnostics: string[] = [];
    assert.equal(await invoke(provider, { format: "text", prompt: "hello" }, diagnostics), "Final answer.");
    assert.match(diagnostics[0]!, /1 tool attempt\(s\) were denied/u);
  });
  assert.throws(() => parseOpenCodeEvents("not json\n", "ollama/x"), (error: OpenCodeError) => error.code === "OPENCODE_MALFORMED_OUTPUT");
});

test("hosted models need an explicit opt-in; unsupported controls are refused, not dropped", () => {
  assert.throws(() => createOpenCodeTextProvider({ model: "opencode/big-pickle", launcher }), /allowHostedModel/u);
  const hosted = createOpenCodeTextProvider({ model: "opencode/big-pickle", launcher, allowHostedModel: true });
  assert.equal(hosted.endpoint.pricing, undefined, "a hosted route's pricing is unknown, never local");
  assert.equal(hosted.endpoint.offers[0]?.transient, undefined);
  assert.throws(() => createOpenCodeTextProvider({ model: "qwen2.5", launcher }), /provider\/model/u);
  const support = createOpenCodeTextProvider({ model: "ollama/qwen2.5:1.5b", launcher }).endpoint.offers[0]!.supports!;
  const request = { capability: textGenerationCapabilities.generate, returns: textTypes.text };
  assert.match(String((support({ ...request, constraints: { format: "text", maxTokens: 50 } }) as { reason?: string }).reason), /max-tokens/u);
  assert.match(String((support({ ...request, constraints: { format: "text", seed: 1 } }) as { reason?: string }).reason), /seed/u);
  assert.equal(support({ ...request, constraints: { format: "json", temperature: 0.2 } }).status, "supported");
  assert.equal(support({ ...request, constraints: { format: "text", prompt: "x".repeat(24_001) } }).status, "unsupported");
});

test("Profile activation finds opencode on PATH or takes an absolute command, and resolves the npm shim", async () => {
  const activate = (config: Record<string, unknown>) => (hypitPackage.facets[0]!.implementation as {
    activate(context: unknown): unknown;
  }).activate({ hostStateRoot: "/tmp/h", dataRoot: "/tmp/d", instance: "opencode.local", config });
  assert.throws(() => activate({ command: process.execPath }), /requires config\.model/u);
  assert.throws(() => activate({ command: "opencode", model: "ollama/qwen2.5:1.5b" }), /absolute path/u);
  assert.throws(() => activate({ command: process.execPath, model: "opencode/big-pickle" }), /allowHostedModel/u);
  assert.throws(() => activate({ command: process.execPath, model: "ollama/qwen2.5:1.5b", apiKey: "x" }), /apiKey/u);
  assert.throws(() => activate({ command: join(tmpdir(), "missing", "opencode.cmd"), model: "ollama/qwen2.5:1.5b" }), /Cannot find the OpenCode binary/u);
  assert.ok(activate({ command: process.execPath, model: "ollama/qwen2.5:1.5b" }));
  const directory = await mkdtemp(join(tmpdir(), "hypit-path-"));
  try {
    const bin = join(directory, "node_modules", "opencode-ai", "bin");
    await mkdir(bin, { recursive: true });
    const shim = join(directory, process.platform === "win32" ? "opencode.cmd" : "opencode");
    await writeFile(shim, "");
    await writeFile(join(bin, process.platform === "win32" ? "opencode.exe" : "opencode"), "");
    assert.equal(findOpenCodeOnPath({ PATH: `${join(directory, "nothing")}${delimiter}${directory}` }), shim);
    assert.equal(findOpenCodeOnPath({ PATH: join(directory, "nothing") }), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
