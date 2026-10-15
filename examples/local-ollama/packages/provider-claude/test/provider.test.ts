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
import { ClaudeCliError, createClaudeTextProvider, findClaudeOnPath } from "../src/index.js";

const fake = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const launcher = { command: process.execPath, args: [fake] };

type Call = { args: string[]; prompt: string; cwd: string; env: Record<string, string | null> };

async function withBehavior<T>(behavior: string, action: (calls: () => Promise<Call[]>) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "hypit-fake-claude-"));
  const record = join(directory, "calls.jsonl");
  const saved = { bedrock: process.env.CLAUDE_CODE_USE_BEDROCK, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  process.env.FAKE_CLAUDE_BEHAVIOR = behavior;
  process.env.FAKE_CLAUDE_RECORD = record;
  // Routing a user might have set globally must not leak into a local run.
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "SECRET-OAUTH";
  try {
    return await action(async () => (await readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line)));
  } finally {
    delete process.env.FAKE_CLAUDE_BEHAVIOR;
    delete process.env.FAKE_CLAUDE_RECORD;
    if (saved.bedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK; else process.env.CLAUDE_CODE_USE_BEDROCK = saved.bedrock;
    if (saved.oauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.oauth;
    await rm(directory, { recursive: true, force: true });
  }
}

async function invoke(provider: ReturnType<typeof createClaudeTextProvider>, request: TextGenerationRequest, diagnostics: string[] = []) {
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

test("runs claude -p once, tool-less, with the prompt on stdin and every model route pointed at local Ollama", async () => {
  await withBehavior("ok", async (calls) => {
    const provider = createClaudeTextProvider({ model: "qwen2.5:1.5b", launcher });
    const diagnostics: string[] = [];
    const prompt = "SECRET-PROMPT -- write a hook; with \"quotes\" & symbols\nand a second line";
    const text = await invoke(provider, { format: "text", prompt, system: "House style." }, diagnostics);
    assert.equal(text, `Fake reply (${prompt.length} prompt characters).`);
    const [call] = await calls();
    assert.equal(call!.prompt, prompt, "the prompt reaches the CLI unaltered on stdin");
    assert.deepEqual(call!.args, ["-p", "--bare", "--no-session-persistence", "--output-format", "json",
      "--model", "qwen2.5:1.5b", "--system-prompt", "House style.", "--tools", "", "--strict-mcp-config", "--disable-slash-commands"]);
    assert.match(call!.cwd, /hypit-claude-/u);
    assert.deepEqual(call!.env, {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:11434", ANTHROPIC_API_KEY: "ollama",
      ANTHROPIC_SMALL_FAST_MODEL: "qwen2.5:1.5b", ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen2.5:1.5b",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_USE_BEDROCK: null, CLAUDE_CODE_OAUTH_TOKEN: null,
    });
    assert.match(diagnostics[0]!, /Ollama qwen2\.5:1\.5b at http:\/\/127\.0\.0\.1:11434: 12 input tokens, 8 output tokens/u);
    assert.doesNotMatch(diagnostics.join("\n"), /SECRET|Fake reply/u);
    assert.equal(provider.endpoint.pricing?.kind, "local");
    assert.equal(provider.endpoint.credentials.length, 0);
    assert.equal(provider.endpoint.offers[0]?.transient, true);
  });
});

test("JSON requests add a JSON-only instruction, unwrap a fence and must parse", async () => {
  const provider = createClaudeTextProvider({ model: "qwen2.5:1.5b", launcher });
  await withBehavior("ok", async (calls) => {
    assert.deepEqual(JSON.parse(await invoke(provider, { format: "json", prompt: "shots" })), { shots: [] });
    const system = (await calls())[0]!.args[8]!;
    assert.match(system, /exactly one valid JSON document/u);
  });
  await withBehavior("fenced-json", async () => {
    assert.deepEqual(JSON.parse(await invoke(provider, { format: "json", prompt: "shots" })), { shots: [1] });
  });
  await withBehavior("bad-json", async () => {
    await assert.rejects(invoke(provider, { format: "json", prompt: "shots" }),
      (error: ClaudeCliError) => error.code === "CLAUDE_CLI_INVALID_JSON_OUTPUT");
  });
});

test("failures keep distinct codes after exactly one run, with no fallback", async () => {
  const cases: [string, string, number?][] = [
    ["model-missing", "CLAUDE_CLI_MODEL_NOT_FOUND"],
    ["backend-down", "CLAUDE_CLI_BACKEND_UNAVAILABLE"],
    ["crash", "CLAUDE_CLI_FAILED"],
    ["not-json", "CLAUDE_CLI_MALFORMED_OUTPUT"],
    ["empty", "CLAUDE_CLI_EMPTY_OUTPUT"],
    ["hang", "CLAUDE_CLI_TIMEOUT", 1500],
  ];
  for (const [behavior, code, requestTimeoutMs] of cases) {
    await withBehavior(behavior, async (calls) => {
      const provider = createClaudeTextProvider({
        model: "qwen2.5:1.5b", launcher, ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      });
      await assert.rejects(invoke(provider, { format: "text", prompt: "hello" }), (error: ClaudeCliError) => {
        assert.equal(error.code, code, behavior);
        if (code === "CLAUDE_CLI_MODEL_NOT_FOUND") assert.match(error.message, /ollama pull qwen2\.5:1\.5b/u);
        return true;
      });
      assert.equal((await calls()).length, 1, `${behavior}: exactly one CLI run`);
    });
  }
  const missing = createClaudeTextProvider({ model: "qwen2.5:1.5b", launcher: { command: join(tmpdir(), "no-such-claude.exe"), args: [] } });
  await assert.rejects(invoke(missing, { format: "text", prompt: "hello" }), (error: ClaudeCliError) => error.code === "CLAUDE_CLI_NOT_FOUND");
});

test("sampling controls the CLI cannot carry are refused, and only loopback Ollama is accepted by default", () => {
  const support = createClaudeTextProvider({ model: "qwen2.5:1.5b", launcher }).endpoint.offers[0]!.supports!;
  const request = { capability: textGenerationCapabilities.generate, returns: textTypes.text };
  const reason = (constraints: Record<string, string | number>) => (support({ ...request, constraints }) as { reason?: string }).reason ?? "";
  assert.match(reason({ format: "text", temperature: 0.5 }), /temperature/u);
  assert.match(reason({ format: "text", maxTokens: 50, seed: 2 }), /max-tokens, seed/u);
  assert.equal(support({ ...request, constraints: { format: "json" } }).status, "supported");
  assert.throws(() => createClaudeTextProvider({ model: "qwen2.5:1.5b", launcher, ollamaBaseUrl: "http://10.0.0.9:11434" }), /not loopback/u);
  assert.ok(createClaudeTextProvider({ model: "qwen2.5:1.5b", launcher, ollamaBaseUrl: "http://10.0.0.9:11434", allowNetworkHost: true }));
  assert.throws(() => createClaudeTextProvider({ model: "claude opus!", launcher }), /Ollama model tag/u);
});

test("Profile activation finds claude on PATH or takes an absolute command, and resolves the npm shim", async () => {
  const activate = (config: Record<string, unknown>) => (hypitPackage.facets[0]!.implementation as {
    activate(context: unknown): unknown;
  }).activate({ hostStateRoot: "/tmp/h", dataRoot: "/tmp/d", instance: "claude.local", config });
  assert.throws(() => activate({ command: process.execPath }), /requires config\.model/u);
  assert.throws(() => activate({ command: "claude", model: "qwen2.5:1.5b" }), /absolute path/u);
  assert.throws(() => activate({ command: process.execPath, model: "qwen2.5:1.5b", apiKey: "x" }), /apiKey/u);
  assert.throws(() => activate({ command: join(tmpdir(), "missing", "claude.cmd"), model: "qwen2.5:1.5b" }), /Cannot find the Claude CLI binary/u);
  assert.ok(activate({ command: process.execPath, model: "qwen2.5:1.5b" }));
  const directory = await mkdtemp(join(tmpdir(), "hypit-path-"));
  try {
    const bin = join(directory, "node_modules", "@anthropic-ai", "claude-code", "bin");
    await mkdir(bin, { recursive: true });
    const shim = join(directory, process.platform === "win32" ? "claude.cmd" : "claude");
    await writeFile(shim, "");
    await writeFile(join(bin, process.platform === "win32" ? "claude.exe" : "claude"), "");
    assert.equal(findClaudeOnPath({ PATH: `${join(directory, "nothing")}${delimiter}${directory}` }), shim);
    assert.equal(findClaudeOnPath({ PATH: join(directory, "nothing") }), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
