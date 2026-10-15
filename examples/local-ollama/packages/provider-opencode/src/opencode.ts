/**
 * Runs the OpenCode CLI (`opencode run --format json`) as a one-shot text generator.
 * Every run gets an empty working directory and an injected agent whose permissions deny all
 * tools, so OpenCode can only answer; it cannot read, edit, run commands or browse.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";

export type OpenCodeErrorCode =
  | "OPENCODE_NOT_FOUND"
  | "OPENCODE_TIMEOUT"
  | "OPENCODE_FAILED"
  | "OPENCODE_HOSTED_REFUSED"
  | "OPENCODE_MODEL_NOT_FOUND"
  | "OPENCODE_BACKEND_UNAVAILABLE"
  | "OPENCODE_MALFORMED_OUTPUT"
  | "OPENCODE_OUTPUT_TOO_LARGE"
  | "OPENCODE_EMPTY_OUTPUT"
  | "OPENCODE_INVALID_JSON_OUTPUT";

/** Failure with a stable code. Messages never include the prompt or generated text. */
export class OpenCodeError extends Error {
  readonly code: OpenCodeErrorCode;
  constructor(code: OpenCodeErrorCode, message: string) {
    super(message);
    this.name = "OpenCodeError";
    this.code = code;
  }
}

export type OpenCodeLauncher = { readonly command: string; readonly args: readonly string[] };

export const openCodeDefaults = {
  requestTimeoutMs: 10 * 60_000,
  probeTimeoutMs: 60_000,
  maxOutputBytes: 8 * 1024 * 1024,
  agent: "hypit-text",
} as const;

/** OpenCode model ids are `provider/model`, e.g. `ollama/qwen2.5:1.5b`. */
export function verifyOpenCodeModel(value: unknown, subject = "OpenCode model"): string {
  if (typeof value !== "string" || value.length > 200 || !/^[a-z0-9][a-z0-9._-]*\/[^\s"'`]+$/iu.test(value)) {
    throw new Error(`${subject} must look like provider/model, e.g. ollama/qwen2.5:1.5b`);
  }
  return value;
}

export function openCodeModelProvider(model: string): string {
  return model.slice(0, model.indexOf("/"));
}

/** Locate an installed `opencode` on PATH, as a shell would, without running a shell. */
export function findOpenCodeOnPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  const names = process.platform === "win32" ? ["opencode.cmd", "opencode.exe"] : ["opencode"];
  for (const directory of pathValue.split(separator)) {
    if (directory.trim() === "") continue;
    for (const name of names) {
      const candidate = join(directory.replace(/^"|"$/gu, ""), name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Resolve the executable to spawn without a shell. An npm-installed `opencode.cmd` is a shim around
 * `node_modules/opencode-ai/bin/opencode(.exe)`; spawning that binary directly avoids cmd.exe
 * argument re-parsing, which could otherwise alter or inject into prompt text.
 */
export function resolveOpenCodeCommand(path: string): string {
  if (!isAbsolute(path)) throw new Error("OpenCode command must be an absolute path to opencode(.cmd|.exe)");
  const extension = extname(path).toLowerCase();
  if ([".cmd", ".bat", ".ps1"].includes(extension) || (extension === "" && process.platform === "win32")) {
    const bin = join(dirname(path), "node_modules", "opencode-ai", "bin");
    const candidate = join(bin, process.platform === "win32" ? "opencode.exe" : "opencode");
    if (!existsSync(candidate)) {
      throw new Error(`Cannot find the OpenCode binary behind ${basename(path)}; set command to the opencode executable itself`);
    }
    return candidate;
  }
  if (!existsSync(path)) throw new Error(`OpenCode command ${path} does not exist`);
  return path;
}

type Event = Record<string, unknown>;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  }
}

function errorFromEvent(event: Event, model: string): OpenCodeError {
  const error = object(event.error);
  const name = typeof error?.name === "string" ? error.name : "Error";
  const data = object(error?.data);
  const body = typeof data?.responseBody === "string" ? data.responseBody : "";
  const raw = typeof data?.message === "string" ? data.message : typeof error?.message === "string" ? error.message : name;
  const message = raw.replace(/https?:\/\/\S+/giu, "[url]").replace(/\s+/gu, " ").slice(0, 300);
  if (/FreeTierError/u.test(body) || /free tier/iu.test(raw)) {
    return new OpenCodeError("OPENCODE_HOSTED_REFUSED", `OpenCode's hosted model ${model} refused automated use: ${message}`);
  }
  if (/not found|model.*(does not exist|unknown)|ProviderModelNotFound/iu.test(`${name} ${raw}`)) {
    return new OpenCodeError("OPENCODE_MODEL_NOT_FOUND",
      `OpenCode cannot use model ${model}: ${message}. Check \`opencode models\`${model.startsWith("ollama/") ? ` and \`ollama pull ${model.slice(7)}\`` : ""}.`);
  }
  if (/ECONNREFUSED|connect|fetch failed|Unable to connect/iu.test(raw)) {
    return new OpenCodeError("OPENCODE_BACKEND_UNAVAILABLE",
      `OpenCode could not reach the backend for ${model}: ${message}${model.startsWith("ollama/") ? ". Start Ollama (`ollama serve`)" : ""}.`);
  }
  return new OpenCodeError("OPENCODE_FAILED", `OpenCode ${name}: ${message}`);
}

export type OpenCodeRunRequest = {
  readonly model: string;
  readonly prompt: string;
  readonly system: string;
  readonly temperature?: number;
  /**
   * Restrict OpenCode to this model's provider for the run, including its background "small model"
   * calls (titles, summaries), so a local route never reaches a hosted service.
   */
  readonly onlyThisProvider?: boolean;
};

export type OpenCodeRunResult = {
  readonly text: string;
  readonly finishReason?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly toolAttempts: number;
};

/** Parse `--format json` output: the reply is the text parts of the last assistant message. */
export function parseOpenCodeEvents(stdout: string, model: string): OpenCodeRunResult {
  const texts = new Map<string, { message: string; text: string }>();
  let lastMessage: string | undefined;
  let finishReason: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let toolAttempts = 0;
  let sawEvent = false;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    let event: Event | undefined;
    try { event = object(JSON.parse(line)); } catch { event = undefined; }
    if (event === undefined || typeof event.type !== "string") continue;
    sawEvent = true;
    const part = object(event.part);
    if (event.type === "error") throw errorFromEvent(event, model);
    if (event.type === "tool_use") toolAttempts += 1;
    if (event.type === "text" && part !== undefined && typeof part.text === "string" && typeof part.id === "string") {
      const message = typeof part.messageID === "string" ? part.messageID : "";
      texts.set(part.id, { message, text: part.text });
      lastMessage = message;
    }
    if (event.type === "step_finish" && part !== undefined) {
      if (typeof part.reason === "string") finishReason = part.reason;
      const tokens = object(part.tokens);
      if (typeof tokens?.input === "number") inputTokens = tokens.input;
      if (typeof tokens?.output === "number") outputTokens = tokens.output;
    }
  }
  if (!sawEvent) throw new OpenCodeError("OPENCODE_MALFORMED_OUTPUT", "OpenCode produced no JSON events");
  const text = [...texts.values()].filter((item) => item.message === lastMessage).map((item) => item.text).join("");
  return {
    text,
    toolAttempts,
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

export function createOpenCodeRunner(options: {
  readonly launcher: OpenCodeLauncher;
  readonly requestTimeoutMs?: number;
  readonly maxOutputBytes?: number;
}) {
  const timeoutMs = options.requestTimeoutMs ?? openCodeDefaults.requestTimeoutMs;
  const maxBytes = options.maxOutputBytes ?? openCodeDefaults.maxOutputBytes;

  function exec(args: readonly string[], env: NodeJS.ProcessEnv, cwd: string, timeout: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(options.launcher.command, [...options.launcher.args, ...args], {
          cwd, env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch {
        reject(new OpenCodeError("OPENCODE_NOT_FOUND", `Cannot start OpenCode at ${options.launcher.command}`));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (action: () => void) => { if (!settled) { settled = true; clearTimeout(timer); action(); } };
      const timer = setTimeout(() => finish(() => {
        killTree(child.pid);
        reject(new OpenCodeError("OPENCODE_TIMEOUT", `OpenCode did not finish within ${timeout} ms`));
      }), timeout);
      child.stdout?.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxBytes) {
          finish(() => {
            killTree(child.pid);
            reject(new OpenCodeError("OPENCODE_OUTPUT_TOO_LARGE", `OpenCode output exceeded ${maxBytes} bytes`));
          });
          return;
        }
        out.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => { if (err.length < 64) err.push(chunk); });
      child.on("error", (error: NodeJS.ErrnoException) => finish(() => reject(new OpenCodeError("OPENCODE_NOT_FOUND",
        `Cannot start OpenCode at ${options.launcher.command}: ${error.code ?? error.message}`))));
      child.on("close", (code) => finish(() => resolve({
        code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"),
      })));
    });
  }

  return {
    launcher: options.launcher,

    async version(timeout: number = openCodeDefaults.probeTimeoutMs): Promise<string> {
      const result = await exec(["--version"], process.env, tmpdir(), timeout);
      const version = result.stdout.trim();
      if (result.code !== 0 || version === "") throw new OpenCodeError("OPENCODE_FAILED", "`opencode --version` failed");
      return version;
    },

    /** Models OpenCode can address (configured providers), without calling any of them. */
    async models(timeout: number = openCodeDefaults.probeTimeoutMs): Promise<readonly string[]> {
      const result = await exec(["models"], process.env, tmpdir(), timeout);
      if (result.code !== 0) throw new OpenCodeError("OPENCODE_FAILED", "`opencode models` failed");
      return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.includes("/"));
    },

    async run(request: OpenCodeRunRequest): Promise<OpenCodeRunResult> {
      const work = await mkdtemp(join(tmpdir(), "hypit-opencode-"));
      try {
        // A private agent for this run only; global config is merged underneath and left untouched.
        const config = {
          share: "disabled",
          autoupdate: false,
          ...(request.onlyThisProvider === true ? {
            enabled_providers: [openCodeModelProvider(request.model)],
            model: request.model,
            small_model: request.model,
          } : {}),
          agent: {
            [openCodeDefaults.agent]: {
              mode: "primary",
              description: "One-shot text generation for Hypit. No tools.",
              prompt: request.system,
              permission: { "*": "deny" },
              ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            },
          },
        };
        const env = { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
        const args = ["run", "--pure", "--format", "json", "--agent", openCodeDefaults.agent,
          "-m", request.model, "--dir", work, "--", request.prompt];
        const result = await exec(args, env, work, timeoutMs);
        let parsed: OpenCodeRunResult;
        try {
          parsed = parseOpenCodeEvents(result.stdout, request.model);
        } catch (error) {
          if (error instanceof OpenCodeError && error.code === "OPENCODE_MALFORMED_OUTPUT" && result.code !== 0) {
            const detail = result.stderr.replace(/\s+/gu, " ").trim().slice(0, 300);
            throw new OpenCodeError("OPENCODE_FAILED", `OpenCode exited with code ${result.code}${detail === "" ? "" : `: ${detail}`}`);
          }
          throw error;
        }
        if (result.code !== 0 && parsed.text.trim() === "") {
          throw new OpenCodeError("OPENCODE_FAILED", `OpenCode exited with code ${result.code}`);
        }
        return parsed;
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

export type OpenCodeRunner = ReturnType<typeof createOpenCodeRunner>;
