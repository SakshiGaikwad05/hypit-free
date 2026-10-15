/**
 * Runs the Claude Code CLI (`claude -p`) as a one-shot text generator against a LOCAL Ollama model.
 * Ollama serves the Anthropic Messages API, so pointing ANTHROPIC_BASE_URL at it keeps inference on
 * this machine. `--bare` limits authentication to ANTHROPIC_API_KEY (never OAuth or a subscription),
 * `--tools ""` removes every tool and `--system-prompt` replaces Claude Code's own prompt.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";

export type ClaudeCliErrorCode =
  | "CLAUDE_CLI_NOT_FOUND"
  | "CLAUDE_CLI_TIMEOUT"
  | "CLAUDE_CLI_FAILED"
  | "CLAUDE_CLI_MODEL_NOT_FOUND"
  | "CLAUDE_CLI_BACKEND_UNAVAILABLE"
  | "CLAUDE_CLI_MALFORMED_OUTPUT"
  | "CLAUDE_CLI_OUTPUT_TOO_LARGE"
  | "CLAUDE_CLI_EMPTY_OUTPUT"
  | "CLAUDE_CLI_INVALID_JSON_OUTPUT";

/** Failure with a stable code. Messages never include the prompt or generated text. */
export class ClaudeCliError extends Error {
  readonly code: ClaudeCliErrorCode;
  constructor(code: ClaudeCliErrorCode, message: string) {
    super(message);
    this.name = "ClaudeCliError";
    this.code = code;
  }
}

export type ClaudeLauncher = { readonly command: string; readonly args: readonly string[] };

export const claudeCliDefaults = {
  requestTimeoutMs: 10 * 60_000,
  probeTimeoutMs: 60_000,
  maxOutputBytes: 8 * 1024 * 1024,
} as const;

/** Variables that could route the CLI to a cloud provider or another endpoint; always removed. */
const routingVariables = [
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_MODEL", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_OAUTH_TOKEN",
];

/** Locate an installed `claude` on PATH, as a shell would, without running a shell. */
export function findClaudeOnPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  const names = process.platform === "win32" ? ["claude.cmd", "claude.exe"] : ["claude"];
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
 * An npm-installed `claude.cmd` is a shim around `node_modules/@anthropic-ai/claude-code/bin/claude(.exe)`.
 * Spawning that binary directly avoids cmd.exe re-parsing arguments such as the system prompt.
 */
export function resolveClaudeCommand(path: string): string {
  if (!isAbsolute(path)) throw new Error("Claude CLI command must be an absolute path to claude(.cmd|.exe)");
  const extension = extname(path).toLowerCase();
  if ([".cmd", ".bat", ".ps1"].includes(extension) || (extension === "" && process.platform === "win32")) {
    const bin = join(dirname(path), "node_modules", "@anthropic-ai", "claude-code", "bin");
    const candidate = join(bin, process.platform === "win32" ? "claude.exe" : "claude");
    if (!existsSync(candidate)) {
      throw new Error(`Cannot find the Claude CLI binary behind ${basename(path)}; set command to the claude executable itself`);
    }
    return candidate;
  }
  if (!existsSync(path)) throw new Error(`Claude CLI command ${path} does not exist`);
  return path;
}

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

export type ClaudeRunResult = {
  readonly text: string;
  readonly stopReason?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly durationMs?: number;
};

function classify(raw: string, model: string, base: string): ClaudeCliError {
  const message = raw.replace(/https?:\/\/\S+/giu, "[url]").replace(/\s+/gu, " ").trim().slice(0, 300);
  if (/not[ _-]?found|does not exist|try pulling/iu.test(raw) && /model|404/iu.test(raw)) {
    return new ClaudeCliError("CLAUDE_CLI_MODEL_NOT_FOUND",
      `Ollama at ${base} does not serve ${model}: ${message}. Download it with \`ollama pull ${model}\`.`);
  }
  if (/ECONNREFUSED|Unable to connect|ConnectionRefused|fetch failed|connect/iu.test(raw)) {
    return new ClaudeCliError("CLAUDE_CLI_BACKEND_UNAVAILABLE",
      `The Claude CLI could not reach Ollama at ${base}: ${message}. Start Ollama (\`ollama serve\`).`);
  }
  return new ClaudeCliError("CLAUDE_CLI_FAILED", `Claude CLI: ${message}`);
}

/** Parse `--output-format json`: one result object (or, defensively, an array containing it). */
export function parseClaudeResult(stdout: string, model: string, base: string): ClaudeRunResult {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.trim()); } catch {
    throw new ClaudeCliError("CLAUDE_CLI_MALFORMED_OUTPUT", "The Claude CLI did not print a JSON result");
  }
  const result = Array.isArray(parsed)
    ? parsed.map(object).findLast((item) => item?.type === "result")
    : object(parsed);
  if (result === undefined || result.type !== "result") {
    throw new ClaudeCliError("CLAUDE_CLI_MALFORMED_OUTPUT", "The Claude CLI JSON has no result");
  }
  const text = typeof result.result === "string" ? result.result : "";
  if (result.is_error === true || (typeof result.subtype === "string" && result.subtype !== "success")) {
    const errors = Array.isArray(result.errors) ? result.errors.filter((item) => typeof item === "string").join("; ") : "";
    throw classify(text || errors || String(result.subtype ?? "error"), model, base);
  }
  const usage = object(result.usage);
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const inputTokens = number(usage?.input_tokens);
  const outputTokens = number(usage?.output_tokens);
  const durationMs = number(result.duration_ms);
  const stopReason = typeof result.stop_reason === "string" ? result.stop_reason : undefined;
  return {
    text,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

export function createClaudeRunner(options: {
  readonly launcher: ClaudeLauncher;
  /** Normalized loopback (or explicitly allowed) Ollama address. */
  readonly ollamaBaseUrl: string;
  readonly requestTimeoutMs?: number;
  readonly maxOutputBytes?: number;
}) {
  const timeoutMs = options.requestTimeoutMs ?? claudeCliDefaults.requestTimeoutMs;
  const maxBytes = options.maxOutputBytes ?? claudeCliDefaults.maxOutputBytes;
  const base = options.ollamaBaseUrl;

  /** Every inference variable points at the local Ollama; nothing can reach Anthropic or a cloud. */
  function localEnv(model: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of routingVariables) delete env[name];
    return {
      ...env,
      ANTHROPIC_BASE_URL: base,
      // Ollama ignores the value; --bare authenticates only with ANTHROPIC_API_KEY.
      ANTHROPIC_API_KEY: "ollama",
      ANTHROPIC_AUTH_TOKEN: "ollama",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_ERROR_REPORTING: "1",
    };
  }

  function exec(args: readonly string[], env: NodeJS.ProcessEnv, cwd: string, timeout: number, input?: string) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(options.launcher.command, [...options.launcher.args, ...args], {
          cwd, env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch {
        reject(new ClaudeCliError("CLAUDE_CLI_NOT_FOUND", `Cannot start the Claude CLI at ${options.launcher.command}`));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (action: () => void) => { if (!settled) { settled = true; clearTimeout(timer); action(); } };
      const timer = setTimeout(() => finish(() => {
        killTree(child.pid);
        reject(new ClaudeCliError("CLAUDE_CLI_TIMEOUT", `The Claude CLI did not finish within ${timeout} ms`));
      }), timeout);
      child.stdout?.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxBytes) {
          finish(() => {
            killTree(child.pid);
            reject(new ClaudeCliError("CLAUDE_CLI_OUTPUT_TOO_LARGE", `Claude CLI output exceeded ${maxBytes} bytes`));
          });
          return;
        }
        out.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => { if (err.length < 64) err.push(chunk); });
      child.stdin?.on("error", () => {});
      child.stdin?.end(input ?? "");
      child.on("error", (error: NodeJS.ErrnoException) => finish(() => reject(new ClaudeCliError("CLAUDE_CLI_NOT_FOUND",
        `Cannot start the Claude CLI at ${options.launcher.command}: ${error.code ?? error.message}`))));
      child.on("close", (code) => finish(() => resolve({
        code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"),
      })));
    });
  }

  return {
    launcher: options.launcher,
    ollamaBaseUrl: base,

    async version(timeout: number = claudeCliDefaults.probeTimeoutMs): Promise<string> {
      const result = await exec(["--version"], process.env, tmpdir(), timeout);
      const version = result.stdout.trim();
      if (result.code !== 0 || version === "") throw new ClaudeCliError("CLAUDE_CLI_FAILED", "`claude --version` failed");
      return version;
    },

    async run(request: { readonly model: string; readonly system: string; readonly prompt: string }): Promise<ClaudeRunResult> {
      const work = await mkdtemp(join(tmpdir(), "hypit-claude-"));
      try {
        const args = [
          "-p", "--bare", "--no-session-persistence", "--output-format", "json",
          "--model", request.model,
          "--system-prompt", request.system,
          "--tools", "",
          "--strict-mcp-config", "--disable-slash-commands",
        ];
        // The prompt travels on stdin: no command-line length limit and no argument parsing.
        const result = await exec(args, localEnv(request.model), work, timeoutMs, request.prompt);
        try {
          return parseClaudeResult(result.stdout, request.model, base);
        } catch (error) {
          if (error instanceof ClaudeCliError && error.code === "CLAUDE_CLI_MALFORMED_OUTPUT" && result.code !== 0) {
            throw classify(result.stderr || `exit code ${result.code}`, request.model, base);
          }
          throw error;
        }
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

export type ClaudeRunner = ReturnType<typeof createClaudeRunner>;
