# Local text generation with Ollama

This example adds **local AI text generation** to Hypit through its ordinary Model → Provider →
Endpoint → Runtime Profile architecture. Nothing in it calls a paid or hosted API.

| Package | Role |
| --- | --- |
| `packages/text-generation` (`@local/text-generation@1`) | **Model**: the `generate-text` capability, returning ordinary `@hypit/text@1#Text`, and the `<llm:Generate>` Source element |
| `packages/provider-ollama` (`@local/provider-ollama`) | **Provider**: fulfills `generate-text` through Ollama's local HTTP API at `http://127.0.0.1:11434` |
| `hypit.runtime.json` | Example local **Runtime Profile**: the Endpoint (model tag, address, timeouts) and its binding |
| `hooks.svml` / `hooks.svrun` | Sample workflow: two hook variants, a rewrite chained from a generated hook, a voiceover script and a JSON shot list |
| `packages/provider-claude` (`@local/provider-claude`) | **Provider**: fulfills the same `generate-text` capability by running your **Claude Code CLI** (`claude -p`) against the local Ollama model |
| `hypit.runtime.claude.json`, `claude-hooks.svml` / `.svrun` | Profile and sample for the Claude CLI route (see [Route through the Claude CLI](#route-through-the-claude-cli)) |
| `packages/provider-opencode` (`@local/provider-opencode`) | **Provider**: fulfills the same capability by running your **OpenCode CLI** (`opencode run`) with a local `ollama/*` model |
| `hypit.runtime.opencode.json`, `opencode-hooks.svml` / `.svrun` | Profile and sample for the OpenCode route (see [Route through the OpenCode CLI](#route-through-the-opencode-cli)) |
| `scripts/mock-ollama.mjs` | A loopback stand-in for Ollama (native `/api/*`, OpenAI-compatible `/v1/chat/completions`, Anthropic-compatible `/v1/messages`), so you can check the wiring without a model |
| `scripts/draft.ts` | One-off local drafting outside a Build, for example by a coding Agent |

Hypit previously had no text-generation capability: `@hypit/text` only renders deterministic
templates, and every generation Model makes images, video or audio. So this is a new exact
capability, not text squeezed into a video-generation interface. Both packages use only the public
SDK (`@hypit/hypit/*` and `@hypit/runtime-local/extension`).

## Where each decision lives

| Decision | Owner |
| --- | --- |
| Prompts, system instructions, format, temperature, seed | Source (`hooks.svml`) |
| Which model tag, which address, timeouts, context size | Runtime Profile Endpoint config |
| Ollama wire format, validation, errors, readiness | `provider-ollama` |
| Request vocabulary and limits | `text-generation` |

The model is never hard-coded: change `"model"` in the Profile, or add a second Endpoint and bind it.

## 1. Install and start Ollama

Requirements (from Ollama's Windows docs): Windows 10 22H2 or newer, no admin rights, about 4 GB of
disk for Ollama itself plus the models. Models are stored in `%USERPROFILE%\.ollama`. Set the
`OLLAMA_MODELS` user environment variable to put them on another drive.

1. Download and run `OllamaSetup.exe` from <https://ollama.com/download> (macOS and Linux installers are on the same page).
2. Ollama starts in the background (tray icon). Otherwise run `ollama serve`.
3. Check it: `curl http://127.0.0.1:11434/api/version`

## 2. Download the model

```bash
ollama pull qwen2.5:1.5b
```

`qwen2.5:1.5b` is a 986 MB download (Q4_K_M quantization, Apache-2.0 license). It needs about
1.5–2 GB of free RAM while loaded and runs on CPU, so it suits an 8 GB laptop. Expect a few tokens
per second on a 2-core laptop CPU, so a 50-word script takes tens of seconds. Hypit never pulls
models for you: downloads stay an explicit user action.

Other tags that fit 8 GB of RAM: `qwen2.5:0.5b` (smaller and faster, weaker) and `llama3.2:1b`.
Bigger models such as `qwen2.5:3b` (a different, non-Apache Qwen license) or 7B models want more
free memory than a busy 8 GB machine usually has.

## 3. Configure the Provider

The example Profile is `hypit.runtime.json`:

```json
"ollama.local": {
  "use": "@local/provider-ollama",
  "config": {
    "baseUrl": "http://127.0.0.1:11434",
    "model": "qwen2.5:1.5b",
    "contextTokens": 4096,
    "keepAlive": "5m",
    "requestTimeoutMs": 300000
  }
}
```

| Key | Meaning |
| --- | --- |
| `model` (required) | Ollama tag serving every `generate-text` request of this Endpoint |
| `baseUrl` | Defaults to `http://127.0.0.1:11434`. Must be loopback unless `allowNetworkHost` is `true` |
| `allowNetworkHost` | Deliberately allows another machine, such as a GPU desktop on your LAN |
| `requestTimeoutMs` | Per request (default 300000). The first request also loads the model |
| `maxResponseBytes` | Response size cap (default 4 MiB) |
| `contextTokens` | Ollama `num_ctx`. Context costs RAM, so keep it modest on 8 GB |
| `keepAlive` | Ollama `keep_alive`: `5m`, or `0` to unload right after each request and free RAM |
| `defaultConcurrency` | Default 1. One local model already saturates a small machine |

There are no credentials. Pricing is declared `local`, and `plan` shows "local, no Provider charge".

In your own project, copy both packages into its `packages/` folder and merge the Endpoint and
binding into the project's Profile. The packages ship TypeScript sources, which Hypit's package
loader runs directly. Run `npm run build` in each one if you want compiled JavaScript, then point
`hypit.activation` and `exports` at `dist/`.

## 4. Run the sample workflow

From the repository root, after `pnpm install`:

```bash
node bin/hypit.mjs check examples/local-ollama/hooks.svrun --project examples/local-ollama
node bin/hypit.mjs doctor --project examples/local-ollama --runtime examples/local-ollama/hypit.runtime.json
node bin/hypit.mjs plan examples/local-ollama/hooks.svrun --project examples/local-ollama --runtime examples/local-ollama/hypit.runtime.json
node bin/hypit.mjs build examples/local-ollama/hooks.svrun --project examples/local-ollama --runtime examples/local-ollama/hypit.runtime.json --follow
node bin/hypit.mjs get <build-id> --output script --project examples/local-ollama --to ./out/script
```

Each Output is a `Text` value (`value.json`). `shot-list` contains a JSON document. When you're
done, stop the Worker with `node bin/hypit.mjs runtime down --project examples/local-ollama --runtime examples/local-ollama/hypit.runtime.json`.

Use it in your own Source:

```svml
<import as="llm" from="@local/text-generation@1"/>

<llm:Generate id="hook" system={house-style} temperature="0.8" max-tokens="60" seed="1">
  Write one scroll-stopping opening line about cold brew coffee.
</llm:Generate>
<llm:Generate id="hook-rewrite" system={rewrite-rules} prompt={hook} seed="2"/>
<llm:Generate id="shots" format="json" max-tokens="400">Return JSON {"shots": [...]}</llm:Generate>
```

The generated `Text` is an ordinary graph value, so it can feed any `Text` input: on-screen text,
captions, comment stickers, ranking labels, image or video prompts, or speech input. One limit:
a `<script>` block is parsed when Source compiles, so generated text cannot become Script
Segments in the same Run. Draft the script first, then paste it in:

```bash
node --import tsx examples/local-ollama/scripts/draft.ts --max-tokens 200 "Write a 20-second voiceover about cold brew"
```

`<llm:Generate>` is declared `transient`: it's local, free and side-effect free, so Studio may
preview it without a Build.

## 5. Verify that requests go to the local service

- `plan` lists every `generate-text` request under `ollama.local (@local/provider-ollama)` with
  "local, no Provider charge".
- `doctor` prints `OLLAMA_READY: Ollama at http://127.0.0.1:11434 serves qwen2.5:1.5b`.
- `hypit logs <build-id>` shows one entry per request:
  `Ollama qwen2.5:1.5b at http://127.0.0.1:11434: N prompt tokens, M output tokens, T ms`.
  Prompts and generated text are never written to logs or diagnostics.
- Stop Ollama and run `build` again. Preflight fails with `MANAGED_PROGRAM_DOWN` and Hypit
  submits nothing; no other service is tried.
- Without a model, check the wiring against the mock: run
  `node examples/local-ollama/scripts/mock-ollama.mjs --port 11434` instead of Ollama (with Ollama
  stopped, since the port is shared), then build. The outputs read `Mock qwen2.5:1.5b reply …`.

## 6. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `OLLAMA_UNAVAILABLE` / `MANAGED_PROGRAM_DOWN` | Ollama isn't running or listens elsewhere. Start the app or `ollama serve`. Check `baseUrl` |
| `OLLAMA_MODEL_NOT_FOUND` / probe `mismatch` | The tag isn't pulled: `ollama pull <model>`. `ollama list` shows the exact installed tags |
| `OLLAMA_TIMEOUT` | The first load or a long generation on a slow CPU. Raise `requestTimeoutMs`, lower `max-tokens`, or use a smaller model |
| `OLLAMA_INVALID_JSON_OUTPUT` | The model's JSON was cut off or invalid. Raise `max-tokens`, lower `temperature`, show the exact schema in the prompt |
| `OLLAMA_EMPTY_OUTPUT` | The model returned whitespace. Rephrase the prompt or change `seed` |
| `OLLAMA_HTTP_ERROR` (500) | Ollama's runner crashed, often from running out of memory. Close apps, lower `contextTokens`, set `keepAlive` to `0`, use a smaller model |
| `OLLAMA_RESPONSE_TOO_LARGE` | Raise `maxResponseBytes` or lower `max-tokens` |
| `baseUrl host … is not loopback` | Intentional. Set `allowNetworkHost: true` only for a machine you control |
| Port 11434 already in use | The mock and Ollama share the default port. Stop one, or pass `--port` to the mock and change `baseUrl` |

A failed request ends that Build attempt. Nothing is retried through another account or model.

## Route through the Claude CLI

`@local/provider-claude` lets Hypit call your installed Claude Code CLI (`claude -p`) instead of
Ollama's API directly. Ollama serves the Anthropic Messages API, so the CLI runs the **local** Ollama
model. Both Endpoints fulfill the same capability, so the Profile decides; Source doesn't change.

```bash
node bin/hypit.mjs doctor --project examples/local-ollama --runtime examples/local-ollama/hypit.runtime.claude.json
node bin/hypit.mjs build examples/local-ollama/claude-hooks.svrun --project examples/local-ollama --runtime examples/local-ollama/hypit.runtime.claude.json --follow
```

How each request runs:

- The Provider finds `claude` on PATH (or uses `config.command`, an absolute path to `claude.cmd`
  or the executable). For an npm install it spawns the real binary behind the `.cmd` shim,
  `node_modules/@anthropic-ai/claude-code/bin/claude.exe`, directly with no shell.
- `claude -p --bare --no-session-persistence --output-format json --model <tag> --system-prompt <instructions> --tools "" --strict-mcp-config --disable-slash-commands`,
  in an empty temp directory, with the prompt on **stdin**. Prompt text is never parsed as arguments,
  and there's no command-line length limit.
- `--system-prompt` replaces Claude Code's own system prompt, so the small model sees only your
  instructions. `--tools ""` removes every tool. `--bare` skips hooks, plugins, CLAUDE.md and memory.
- The child environment is pinned to the local model: `ANTHROPIC_BASE_URL` is the (loopback) Ollama,
  and the default and small or background models are the same tag. Non-essential traffic,
  telemetry, auto-update and error reporting are off. Bedrock, Vertex, Foundry and OAuth routing
  variables are removed. `--bare` authenticates only through `ANTHROPIC_API_KEY`, which is set to a
  dummy value Ollama ignores, so the CLI never uses your Anthropic subscription or key.
- The reply is the `result` field of the CLI's JSON. `format="json"` requests add a JSON-only
  instruction, remove a surrounding Markdown code fence, and must parse.

| Config key | Meaning |
| --- | --- |
| `model` (required) | Ollama tag, e.g. `qwen2.5:1.5b` |
| `command` | Absolute path to `claude.cmd` or the executable. Omitted: found on PATH |
| `ollamaBaseUrl` | Default `http://127.0.0.1:11434`. Loopback only unless `allowNetworkHost` is `true` |
| `requestTimeoutMs` | Per request (default 600000). CLI startup adds a few seconds per request |
| `maxOutputBytes`, `defaultConcurrency` | Output cap (8 MiB) and parallel runs (1) |

Limits of this route:

- The Claude CLI has no temperature, max-tokens or seed flags. Requests that set them are refused
  with a reason rather than altered (`claude-hooks.svml` sets none). Use the Ollama Endpoint for
  those; `hooks.svml` needs it.
- The CLI prints a `total_cost_usd` *estimate* for unknown models (`costBasis: unknown`). It's not
  a charge: the request went to the local Ollama.
- Claude Code as an interactive coding agent needs a tool-calling model with a large context.
  Ollama recommends 64k or more, which a 1.5B model on 8 GB doesn't provide. This Provider avoids
  that by using the CLI as a plain one-shot text generator.

## Route through the OpenCode CLI

`@local/provider-opencode` lets Hypit call your installed OpenCode CLI. Same capability, so again
only the Profile changes.

```bash
node bin/hypit.mjs doctor --project examples/local-ollama --runtime examples/local-ollama/hypit.runtime.opencode.json
node bin/hypit.mjs build examples/local-ollama/opencode-hooks.svrun --project examples/local-ollama --runtime examples/local-ollama/hypit.runtime.opencode.json --follow
```

How each request runs:

- The Provider finds `opencode` on PATH (or uses `config.command`). For an npm install it spawns the
  real binary behind the `.cmd` shim, `node_modules/opencode-ai/bin/opencode.exe`, with no shell,
  so the prompt reaches OpenCode as one unaltered argument.
- `opencode run --pure --format json --agent hypit-text -m <model> --dir <empty temp dir> -- <prompt>`.
  The `hypit-text` agent is injected for that run only, through `OPENCODE_CONFIG_CONTENT`, with
  `permission: { "*": "deny" }`, so OpenCode can't read, edit, run commands or browse. Your
  `opencode.jsonc` is never modified.
- For a local model the injected config also sets `enabled_providers` to that model's provider and
  pins `model` and `small_model` to it, so background calls (titles, summaries) can't reach a hosted
  service. Sharing and auto-update are disabled for the run.
- The reply is the text of the last assistant message in OpenCode's JSON events. `format="json"`
  adds a JSON-only instruction, strips a Markdown fence, and must parse.

| Config key | Meaning |
| --- | --- |
| `model` (required) | OpenCode `provider/model`, e.g. `ollama/qwen2.5:1.5b`. It must appear in `opencode models` |
| `command` | Absolute path to `opencode.cmd` or the executable. Omitted: found on PATH |
| `ollamaBaseUrl` | Where readiness checks look for Ollama (default `http://127.0.0.1:11434`) |
| `localProviders` | OpenCode providers counted as local (default `["ollama"]`) |
| `allowHostedModel` | Required for any non-local model. Prompts then go to that service, and pricing is unknown |
| `requestTimeoutMs`, `maxOutputBytes`, `defaultConcurrency` | 600000 ms, 8 MiB, 1 |

OpenCode needs the model in its own config. `~/.config/opencode/opencode.jsonc` has an `ollama`
provider (`@ai-sdk/openai-compatible`, `baseURL` `http://127.0.0.1:11434/v1`, model `qwen2.5:1.5b`).

Limits of this route:

- No max-tokens or seed flags: requests that set them are refused with a reason. Temperature is
  supported (agent temperature).
- OpenCode adds its own system prompt and starts a server per run, so it's slower (about 15 s per
  request vs. about 7 s for the Claude CLI). If replies look truncated, raise Ollama's context with
  `OLLAMA_CONTEXT_LENGTH` (e.g. `8192`) before starting Ollama.
- OpenCode's free hosted models refuse this automated use (`FreeTierError`, reported as
  `OPENCODE_HOSTED_REFUSED`). That's their policy, and the Provider doesn't work around it.

Inside OpenCode itself, the `hypit` and `hypit-local-ollama` skills plus the `/hypit-local` and
`/hypit-draft` commands (in `~/.config/opencode/`) drive this example from an OpenCode session.

## 7. Tests

```bash
node --import tsx --test examples/local-ollama/packages/*/test/*.test.ts   # mocked, no model needed
pnpm test:ollama                                                          # live: Ollama running and model pulled
```

The default suite (`pnpm test`) includes the mocked tests. They start the loopback mock and cover
request mapping, JSON validation, missing model, unavailable service, timeout, malformed, empty,
oversized and HTTP-error responses, config validation and readiness probing. `pnpm test:ollama`
sets `HYPIT_OLLAMA_TESTS=1`. `HYPIT_OLLAMA_URL` and `HYPIT_OLLAMA_MODEL` override the address and model.
The live Claude CLI tests find `claude` on PATH, or use `HYPIT_CLAUDE_COMMAND`. The mocked Claude
tests use a fake CLI (`provider-claude/test/fixtures/fake-claude.mjs`) that prints the CLI's JSON
result shape and records the arguments, stdin and routing environment it received. The live OpenCode
tests find `opencode` on PATH (or use `HYPIT_OPENCODE_COMMAND`). Their mocked tests use
`provider-opencode/test/fixtures/fake-opencode.mjs`, which emits OpenCode's JSON event stream.

## What still needs external services

This is local **text** generation. A finished video still needs these:

| Capability | Local today? | Notes |
| --- | --- | --- |
| Text: scripts, hooks, rewrites, JSON | **Yes**, this example | Ollama on CPU |
| Speech transcription and word alignment | **Yes**, existing `@hypit/provider-whisperx-local` | Python 3.10–3.13 and `uv`. `small`/`cpu`/`int8` default. Downloads ASR and alignment weights on `programs prepare` |
| Rendering, compositing, captions, motion graphics | **Yes**, existing `provider-html-local` + `media-local` | Needs Chromium (prepared by `hypit programs up`) and FFmpeg |
| Text-to-speech | No Provider yet | Feasible on CPU (see below). Hosted today: ElevenLabs, Fish Audio, MiMo through HypiHub and partners |
| Image generation | No Provider yet | Marginal on an 8 GB / 2-core laptop (see below) |
| Video and image-to-video generation | No | Not practical without a GPU (see below) |

Complete offline operation is **not** claimed. Ollama, the Chromium preparation, the WhisperX
weights and npm packages all download once. The text workflow above has been verified against the
mock service; it is designed to run offline once Ollama and the model are installed.

## Local alternatives for the remaining capabilities

Assessed for the reference machine this was built on: Intel Core i5-6200U (2 cores / 4 threads),
7.9 GiB RAM, Intel HD 520 graphics (no CUDA), 12 GB free disk. None of these weights were downloaded.

### Hypit contract fit

Hypit's generation Models are **exact named models**: `@hypit/gpt-image@1#gpt-image-2`,
`@hypit/elevenlabs-speech@1#eleven_ttv_v3`, `@hypit/seedance@1#seedance-2-mini`. A local Provider
must not claim one of those capabilities with a different model, because that would mislabel the
result. Each local model therefore gets its own small Model package, built with
`@hypit/generation/model` (`defineExactModelModule`, `sealGenerationPortTable`). It returns the shared
`GeneratedImageSet`, `GeneratedAudioSet` or `GeneratedVideoSet`, so everything downstream (composition,
captions, alignment, rendering) works unchanged. The Provider talks to a loopback service, like the
Ollama and WhisperX Providers do.

### Text-to-speech: feasible on this laptop

| Model | License | Size and hardware | Install | Fit |
| --- | --- | --- | --- | --- |
| **Piper** (`piper-tts`, OHF-Voice/piper1-gpl; original rhasspy/piper archived Oct 2025) | Code GPL-3.0 (the archived original is MIT); each voice has its own license on its model card | CPU-only ONNX voices, typically tens of MB each. Designed for small devices | `pip install piper-tts`, then download a voice | Best first local TTS. A `@local/piper-speech` Model with a `text` port (from Script `.speech` Text or `<llm:Generate>`) returning `GeneratedAudioSet`. Then WhisperX alignment as usual |
| **Kokoro-82M** | Apache-2.0 weights | 82M parameters. Runs on CPU via PyTorch | `pip install kokoro>=0.9.2 soundfile`, plus `espeak-ng` | Better quality than Piper, but needs PyTorch (a large install for 12 GB of free disk) |

Recommended next step: a Piper Provider behind a small loopback HTTP service, managed like the
WhisperX `runtime/` (uv-locked environment, explicit `programs prepare`, health check).

### Image generation: marginal

| Option | License | Requirements | Fit |
| --- | --- | --- | --- |
| **FastSD CPU** (rupeshs/fastsdcpu): SD-Turbo, LCM, LCM-LoRA, optional OpenVINO | MIT app. SD-Turbo weights: research use, commercial use needs a Stability AI license | Its README lists RAM by mode: LCM about 2 GB, LCM-LoRA about 4 GB, OpenVINO 9–11 GB. Published speeds were measured on a 12-core i7-12700, so expect several times slower on a 2-core i5-6200U | Possible at 512×512 in LCM/LCM-LoRA mode. OpenVINO mode exceeds 8 GB. Python plus PyTorch plus about 2–5 GB of weights may not fit in 12 GB of free disk |
| Stable Diffusion 1.5 via `stable-diffusion.cpp` | CreativeML OpenRAIL-M | About 2 GB of weights. Minutes per image on this CPU | Works, slowly. Suitable for batch B-roll stills, not iteration |
| FLUX, SDXL (full) | Varies | 12B+ parameters, or SDXL at more than 8 GB | Not realistic here |

### Video and image-to-video: not practical on this hardware

The smallest open text-to-video model, **Wan2.1 T2V-1.3B** (Apache-2.0), needs **8.19 GB of GPU
VRAM** and about 4 minutes on an RTX 4090 for a 5-second 480p clip, per its README. Wan2.1 documents
GPU inference only. This laptop has no CUDA GPU and 8 GB of system RAM in total.

Modular plan for a stronger machine: a `@local/wan-t2v` Model (prompt, optional first-frame image,
seconds, 480p) returning `GeneratedVideoSet`, and an **asynchronous** Provider (`start` / `poll` /
`collect`, like `examples/provider-package/packages/provider-videos`). It would target a ComfyUI or
Wan inference server on a GPU box, reached with the same explicit opt-in as `allowNetworkHost`. The
laptop keeps authoring, text, alignment and rendering; only the generation Endpoint moves.

Practical alternatives on this laptop: still images plus FFmpeg motion (pan, zoom, crossfades)
through the existing local media and rendering packages, or code-rendered visuals through
`@hypit/html-video`. Both need no generation model.
