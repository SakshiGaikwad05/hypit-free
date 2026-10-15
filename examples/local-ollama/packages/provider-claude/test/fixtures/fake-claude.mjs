// Stand-in for the Claude Code CLI. It prints the `claude -p --output-format json` result shape
// observed from Claude Code 2.1 and records argv, stdin and routing env. Behavior: FAKE_CLAUDE_BEHAVIOR.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const behavior = process.env.FAKE_CLAUDE_BEHAVIOR ?? "ok";
if (args[0] === "--version") { console.log("2.1.283 (Claude Code)"); process.exit(0); }

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const record = process.env.FAKE_CLAUDE_RECORD;
const pick = (names) => Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]));
if (record) appendFileSync(record, JSON.stringify({ args, prompt, cwd: process.cwd(), env: pick([
  "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_OAUTH_TOKEN",
]) }) + "\n");

const system = args[args.indexOf("--system-prompt") + 1] ?? "";
const result = (fields) => console.log(JSON.stringify({
  type: "result", subtype: "success", is_error: false, duration_ms: 279, stop_reason: "end_turn",
  usage: { input_tokens: 12, output_tokens: 8 }, ...fields,
}));
switch (behavior) {
  case "hang": setInterval(() => {}, 1000); break;
  case "crash": process.stderr.write("fatal: something broke\n"); process.exit(2);
  case "model-missing":
    result({ subtype: "success", is_error: true, result: "API Error: 404 {\"type\":\"error\",\"error\":{\"type\":\"not_found_error\",\"message\":\"model \\\"qwen2.5:1.5b\\\" not found, try pulling it first\"}}" });
    process.exit(1);
  case "backend-down":
    result({ is_error: true, result: "API Error: Unable to connect to API (ConnectionRefused)" });
    process.exit(1);
  case "not-json": console.log("Hello from a terminal UI"); break;
  case "empty": result({ result: "  " }); break;
  case "fenced-json": result({ result: "```json\n{\"shots\":[1]}\n```" }); break;
  case "bad-json": result({ result: "{\"shots\": [" }); break;
  default:
    result({ result: /JSON document/u.test(system) ? "{\"shots\":[]}" : `Fake reply (${prompt.length} prompt characters).` });
}
