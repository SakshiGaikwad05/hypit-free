/**
 * Minimal client for the documented Ollama HTTP API (`/api/version`, `/api/tags`, `/api/chat`).
 * It knows nothing about Hypit; the Provider maps Hypit requests onto it.
 */

export const ollamaDefaults = {
  baseUrl: "http://127.0.0.1:11434",
  requestTimeoutMs: 5 * 60_000,
  probeTimeoutMs: 5_000,
  maxResponseBytes: 4 * 1024 * 1024,
} as const;

export type OllamaErrorCode =
  | "OLLAMA_UNAVAILABLE"
  | "OLLAMA_TIMEOUT"
  | "OLLAMA_MODEL_NOT_FOUND"
  | "OLLAMA_HTTP_ERROR"
  | "OLLAMA_MALFORMED_RESPONSE"
  | "OLLAMA_RESPONSE_TOO_LARGE"
  | "OLLAMA_EMPTY_OUTPUT"
  | "OLLAMA_INVALID_JSON_OUTPUT";

/** Failure with a stable code. Messages never contain prompts, request bodies or credentials. */
export class OllamaError extends Error {
  readonly code: OllamaErrorCode;
  constructor(code: OllamaErrorCode, message: string) {
    super(message);
    this.name = "OllamaError";
    this.code = code;
  }
}

export type OllamaChatMessage = { readonly role: "system" | "user" | "assistant"; readonly content: string };

export type OllamaChatRequest = {
  readonly model: string;
  readonly messages: readonly OllamaChatMessage[];
  readonly format?: "json";
  readonly options?: Readonly<Record<string, number>>;
  readonly keepAlive?: string;
};

export type OllamaChatResponse = {
  readonly model: string;
  readonly content: string;
  readonly doneReason?: string;
  readonly promptTokens?: number;
  readonly outputTokens?: number;
  readonly totalDurationMs?: number;
};

export type OllamaClientOptions = {
  readonly baseUrl?: string;
  /** Permit a non-loopback host, such as a stronger machine on the local network. */
  readonly allowNetworkHost?: boolean;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
};

const loopbackHosts = ["127.0.0.1", "localhost", "::1", "[::1]"];

/** Validate and normalize an Ollama address. Exported so Profile activation reports the same rule. */
export function ollamaBaseUrl(value: string, allowNetworkHost = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Ollama baseUrl ${JSON.stringify(value)} is not a URL`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Ollama baseUrl must use http or https");
  if (url.username !== "" || url.password !== "") throw new Error("Ollama baseUrl must not embed credentials");
  if (url.search !== "" || url.hash !== "") throw new Error("Ollama baseUrl must not carry a query or fragment");
  if (!allowNetworkHost && !loopbackHosts.includes(url.hostname)) {
    throw new Error(`Ollama baseUrl host ${url.hostname} is not loopback; set allowNetworkHost to use another machine deliberately`);
  }
  return url.href.replace(/\/+$/u, "");
}

/** Ollama model tags such as `qwen2.5:1.5b`, `llama3.2:3b` or `namespace/model:tag`. */
export function verifyOllamaModelName(value: unknown, subject = "Ollama model"): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._\-/]*(:[a-z0-9][a-z0-9._-]*)?$/iu.test(value) || value.length > 200) {
    throw new Error(`${subject} must be an Ollama model tag such as qwen2.5:1.5b`);
  }
  return value;
}

function positiveInteger(value: number, subject: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${subject} must be a positive integer`);
  return value;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nanosToMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value / 1e6) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Ollama reports failures as `{ "error": "..." }`. Only that short field is surfaced. */
function serviceError(bytes: Uint8Array): string | undefined {
  try {
    const error = object(JSON.parse(Buffer.from(bytes).toString("utf8")))?.error;
    return typeof error === "string" ? error.replace(/\s+/gu, " ").slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

export function createOllamaClient(options: OllamaClientOptions = {}) {
  const base = ollamaBaseUrl(options.baseUrl ?? ollamaDefaults.baseUrl, options.allowNetworkHost === true);
  const timeoutMs = positiveInteger(options.requestTimeoutMs ?? ollamaDefaults.requestTimeoutMs, "requestTimeoutMs");
  const maxBytes = positiveInteger(options.maxResponseBytes ?? ollamaDefaults.maxResponseBytes, "maxResponseBytes");
  const fetcher = options.fetch ?? globalThis.fetch;

  async function read(response: Response, signal: AbortSignal, subject: string): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    if (reader === undefined) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new OllamaError("OLLAMA_RESPONSE_TOO_LARGE", `${subject} exceeded ${maxBytes} bytes`);
      return bytes;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        if (signal.aborted) throw signal.reason;
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new OllamaError("OLLAMA_RESPONSE_TOO_LARGE", `${subject} exceeded ${maxBytes} bytes`);
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }

  async function call(path: string, init: RequestInit, subject: string, timeout = timeoutMs, model?: string): Promise<Record<string, unknown>> {
    const signal = AbortSignal.timeout(timeout);
    let bytes: Uint8Array;
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, { ...init, signal });
      bytes = await read(response, signal, subject);
    } catch (error) {
      if (error instanceof OllamaError) throw error;
      const name = (error as { name?: unknown } | undefined)?.name;
      if (name === "TimeoutError" || (name === "AbortError" && signal.aborted)) {
        throw new OllamaError("OLLAMA_TIMEOUT", `${subject} did not finish within ${timeout} ms at ${base}`);
      }
      throw new OllamaError("OLLAMA_UNAVAILABLE",
        `Ollama is not reachable at ${base}. Start it with \`ollama serve\` (or the Ollama app) and retry.`);
    }
    if (!response.ok) {
      const detail = serviceError(bytes);
      if (response.status === 404 && model !== undefined && (detail === undefined || /not found/iu.test(detail))) {
        throw new OllamaError("OLLAMA_MODEL_NOT_FOUND",
          `Ollama model ${model} is not installed at ${base}. Download it with \`ollama pull ${model}\`.`);
      }
      throw new OllamaError("OLLAMA_HTTP_ERROR",
        `${subject} returned HTTP ${response.status}${detail === undefined ? "" : `: ${detail}`}`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch {
      throw new OllamaError("OLLAMA_MALFORMED_RESPONSE", `${subject} returned a body that is not JSON`);
    }
    const value = object(parsed);
    if (value === undefined) throw new OllamaError("OLLAMA_MALFORMED_RESPONSE", `${subject} returned JSON that is not an object`);
    return value;
  }

  return {
    baseUrl: base,

    async version(timeout: number = ollamaDefaults.probeTimeoutMs): Promise<string> {
      const value = await call("/api/version", { method: "GET" }, "Ollama version check", timeout);
      if (typeof value.version !== "string") throw new OllamaError("OLLAMA_MALFORMED_RESPONSE", "Ollama version response has no version");
      return value.version;
    },

    /** Locally installed model tags. Listing never downloads anything. */
    async models(timeout: number = ollamaDefaults.probeTimeoutMs): Promise<readonly string[]> {
      const value = await call("/api/tags", { method: "GET" }, "Ollama model list", timeout);
      if (!Array.isArray(value.models)) throw new OllamaError("OLLAMA_MALFORMED_RESPONSE", "Ollama model list has no models array");
      return value.models.flatMap((item) => {
        const entry = object(item);
        const name = entry?.name ?? entry?.model;
        return typeof name === "string" ? [name] : [];
      });
    },

    async chat(request: OllamaChatRequest): Promise<OllamaChatResponse> {
      const value = await call("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: false,
          ...(request.format === undefined ? {} : { format: request.format }),
          ...(request.options === undefined || Object.keys(request.options).length === 0 ? {} : { options: request.options }),
          ...(request.keepAlive === undefined ? {} : { keep_alive: request.keepAlive }),
        }),
      }, `Ollama chat with ${request.model}`, timeoutMs, request.model);
      const message = object(value.message);
      if (value.done !== true || message === undefined || typeof message.content !== "string") {
        throw new OllamaError("OLLAMA_MALFORMED_RESPONSE",
          `Ollama chat with ${request.model} returned no completed assistant message`);
      }
      const doneReason = typeof value.done_reason === "string" ? value.done_reason : undefined;
      const promptTokens = count(value.prompt_eval_count);
      const outputTokens = count(value.eval_count);
      const totalDurationMs = nanosToMs(value.total_duration);
      return {
        model: typeof value.model === "string" ? value.model : request.model,
        content: message.content,
        ...(doneReason === undefined ? {} : { doneReason }),
        ...(promptTokens === undefined ? {} : { promptTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(totalDurationMs === undefined ? {} : { totalDurationMs }),
      };
    },
  };
}

export type OllamaClient = ReturnType<typeof createOllamaClient>;

/** Ollama treats `qwen2.5` and `qwen2.5:latest` as the same installed tag. */
export function ollamaModelInstalled(installed: readonly string[], model: string): boolean {
  const normalized = (name: string) => name.includes(":") ? name : `${name}:latest`;
  return installed.some((name) => normalized(name) === normalized(model));
}
