#!/usr/bin/env node
/**
 * A tiny stand-in for the Ollama HTTP API (`/api/version`, `/api/tags`, `/api/chat`) on loopback.
 * It runs no model and downloads nothing. Use it to verify Hypit wiring, and in tests.
 *
 *   node examples/local-ollama/scripts/mock-ollama.mjs [--port 11434] [--model qwen2.5:1.5b]
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/**
 * @param {{ port?: number, models?: string[], behavior?: string }} [options]
 * behavior: "ok" (default) | "hang" | "malformed" | "not-json" | "bad-json-output" | "empty" | "huge" | "error-500"
 */
export async function startMockOllama(options = {}) {
  const models = options.models ?? ["qwen2.5:1.5b"];
  const state = { behavior: options.behavior ?? "ok", requests: [] };
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw.length === 0 ? undefined : JSON.parse(raw);
    state.requests.push({ method: request.method, path: request.url, body });
    const json = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && request.url === "/api/version") return json(200, { version: "0.0.0-mock" });
    if (request.method === "GET" && request.url === "/api/tags") {
      return json(200, { models: models.map((name) => ({ name, model: name, size: 0 })) });
    }
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    // Ollama's Anthropic-compatible Messages API, used by the Claude Code CLI.
    if (request.method === "POST" && pathname === "/v1/messages/count_tokens") {
      return json(200, { input_tokens: 12 });
    }
    if (request.method === "POST" && pathname === "/v1/messages") {
      if (!models.includes(body?.model)) {
        return json(404, { type: "error", error: { type: "not_found_error", message: `model "${body?.model}" not found, try pulling it first` } });
      }
      const flatten = (content) => typeof content === "string" ? content
        : Array.isArray(content) ? content.map((item) => item?.type === "text" ? item.text : "").join("") : "";
      const system = flatten(body.system);
      const user = flatten((body.messages ?? []).findLast((message) => message.role === "user")?.content);
      const content = /JSON document/u.test(system)
        ? JSON.stringify({ shots: [{ seconds: 0, visual: "Mock shot", onScreenText: "Mock text" }] })
        : `Mock ${body.model} Anthropic-compatible reply (${user.length} prompt characters).`;
      const id = `msg_mock_${state.requests.length}`;
      const usage = { input_tokens: 12, output_tokens: 8 };
      if (body.stream !== true) {
        return json(200, { id, type: "message", role: "assistant", model: body.model,
          content: [{ type: "text", text: content }], stop_reason: "end_turn", stop_sequence: null, usage });
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      send("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      for (const piece of content.match(/.{1,16}/gsu) ?? []) send("content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } });
      send("message_stop", {});
      return response.end();
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      return json(200, { object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "library" })) });
    }
    // Ollama's OpenAI-compatible endpoint, used by clients such as OpenCode.
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      if (!models.includes(body?.model)) {
        return json(404, { error: { message: `model "${body?.model}" not found, try pulling it first`, type: "api_error" } });
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const flatten = (content) => typeof content === "string" ? content
        : Array.isArray(content) ? content.map((item) => item?.text ?? "").join("") : "";
      const user = flatten(messages.findLast((message) => message.role === "user")?.content);
      const wantsJson = messages.some((message) => message.role === "system" && /JSON document/u.test(flatten(message.content)));
      const content = wantsJson
        ? JSON.stringify({ shots: [{ seconds: 0, visual: "Mock shot", onScreenText: "Mock text" }] })
        : `Mock ${body.model} OpenAI-compatible reply (${user.length} prompt characters).`;
      const id = `chatcmpl-mock-${state.requests.length}`;
      if (body.stream !== true) {
        return json(200, { id, object: "chat.completion", created: 0, model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } });
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta, finish, usage) => response.write(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created: 0, model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }),
      })}\n\n`);
      chunk({ role: "assistant", content: "" }, null);
      for (const piece of content.match(/.{1,16}/gsu) ?? []) chunk({ content: piece }, null);
      chunk({}, "stop", { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
      response.write("data: [DONE]\n\n");
      return response.end();
    }
    if (request.method !== "POST" || request.url !== "/api/chat") return json(404, { error: "not found" });
    if (!models.includes(body?.model)) return json(404, { error: `model "${body?.model}" not found, try pulling it first` });
    switch (state.behavior) {
      case "hang": return; // Never answers; the client must time out.
      case "error-500": return json(500, { error: "llama runner process has terminated" });
      case "not-json":
        response.writeHead(200, { "content-type": "text/plain" });
        return response.end("<html>proxy page</html>");
      case "malformed": return json(200, { model: body.model, done: true });
      case "huge": return json(200, { model: body.model, done: true, message: { role: "assistant", content: "x".repeat(2_000_000) } });
      default: break;
    }
    const user = body.messages.findLast((message) => message.role === "user")?.content ?? "";
    let content;
    if (state.behavior === "empty") content = "   ";
    else if (state.behavior === "bad-json-output") content = "{\"hooks\": [\"unterminated";
    else if (body.format === "json") content = JSON.stringify({ hooks: ["Mock hook one", "Mock hook two"], words: user.split(/\s+/u).length });
    else content = `Mock ${body.model} reply (${user.length} prompt characters).`;
    return json(200, {
      model: body.model,
      created_at: new Date(0).toISOString(),
      message: { role: "assistant", content },
      done: true,
      done_reason: "stop",
      total_duration: 1_500_000,
      prompt_eval_count: 12,
      eval_count: 8,
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argument = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
  };
  const mock = await startMockOllama({
    port: Number(argument("--port", "11434")),
    models: [argument("--model", "qwen2.5:1.5b")],
  });
  console.log(`Mock Ollama listening on ${mock.baseUrl} (no model runs here). Ctrl+C to stop.`);
  process.on("SIGINT", async () => { await mock.close(); process.exit(0); });
  process.on("SIGTERM", async () => { await mock.close(); process.exit(0); });
  setInterval(() => {
    const chats = mock.state.requests.filter((item) => item.path === "/api/chat");
    if (chats.length > 0) console.log(`${chats.length} chat request(s) received in the last 10 s`);
    mock.state.requests.length = 0;
  }, 10_000).unref();
}
