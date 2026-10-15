// Stand-in for the OpenCode CLI. It emits the `opencode run --format json` event shapes observed from
// opencode 1.18 and records what it received. Behavior comes from FAKE_OPENCODE_BEHAVIOR.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const behavior = process.env.FAKE_OPENCODE_BEHAVIOR ?? "ok";
const record = process.env.FAKE_OPENCODE_RECORD;
if (record) appendFileSync(record, JSON.stringify({ args, cwd: process.cwd(), config: process.env.OPENCODE_CONFIG_CONTENT ?? null }) + "\n");

if (args[0] === "--version") { console.log("1.18.34"); process.exit(0); }
if (args[0] === "models") { console.log("opencode/big-pickle\nollama/qwen2.5:1.5b"); process.exit(0); }

const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const prompt = args[args.indexOf("--") + 1] ?? "";
const base = { timestamp: 1, sessionID: "ses_fake" };
const text = (id, message, value) => emit({ ...base, type: "text", part: { id, messageID: message, type: "text", text: value } });
const finish = (message) => emit({ ...base, type: "step_finish", part: { messageID: message, reason: "stop", tokens: { input: 40, output: 9 } } });

switch (behavior) {
  case "hang": setInterval(() => {}, 1000); break;
  case "crash": process.stderr.write("panic: something broke\n"); process.exit(3);
  case "free-tier":
    emit({ ...base, type: "error", error: { name: "APIError", data: { message: "OpenCode's free tier can only be used from within OpenCode.", responseBody: "{\"error\":{\"type\":\"FreeTierError\"}}" } } });
    process.exit(1);
  case "model-missing":
    emit({ ...base, type: "error", error: { name: "ProviderModelNotFoundError", data: { message: "model qwen2.5:1.5b not found" } } });
    process.exit(1);
  case "backend-down":
    emit({ ...base, type: "error", error: { name: "APIError", data: { message: "Unable to connect. Is the computer able to access the url? ECONNREFUSED" } } });
    process.exit(1);
  case "fenced-json": text("p1", "m1", "```json\n{\"hooks\":[\"a\",\"b\"]}\n```"); finish("m1"); break;
  case "bad-json": text("p1", "m1", "{\"hooks\": [\"a\""); finish("m1"); break;
  case "empty": text("p1", "m1", "  "); finish("m1"); break;
  case "tool-then-answer":
    text("p0", "m0", "Let me look around.");
    emit({ ...base, type: "tool_use", part: { messageID: "m0", tool: "bash", state: { status: "error", error: "denied" } } });
    text("p1", "m1", "Final answer.");
    finish("m1");
    break;
  default:
    text("p1", "m1", `Fake reply (${prompt.length} prompt characters)`);
    text("p2", "m1", ".");
    finish("m1");
}
