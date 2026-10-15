/**
 * Draft text with the local model outside a Build, e.g. for an Agent preparing Script copy.
 * Uses the same client and errors as the Provider. Never falls back to another service.
 *
 *   node --import tsx examples/local-ollama/scripts/draft.ts [--model qwen2.5:1.5b] [--json]
 *     [--system "..."] [--temperature 0.7] [--max-tokens 200] [--seed 1] "prompt"
 */
import { sealTextGenerationRequest } from "../packages/text-generation/src/index.js";
import { createOllamaTextProvider, generateOllamaText, OllamaError } from "../packages/provider-ollama/src/index.js";

const args = process.argv.slice(2);
const flags = new Map<string, string | true>();
const positional: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  const item = args[index]!;
  if (item === "--json") flags.set("json", true);
  else if (item.startsWith("--")) flags.set(item.slice(2), args[++index] ?? "");
  else positional.push(item);
}
const value = (name: string) => { const item = flags.get(name); return typeof item === "string" ? item : undefined; };
const number = (name: string) => { const item = value(name); return item === undefined ? undefined : Number(item); };

const prompt = positional.join(" ");
if (prompt.trim() === "") {
  console.error("Usage: draft.ts [--model tag] [--url http://127.0.0.1:11434] [--json] [--system text] [--temperature n] [--max-tokens n] [--seed n] \"prompt\"");
  process.exit(2);
}
const model = value("model") ?? process.env.HYPIT_OLLAMA_MODEL ?? "qwen2.5:1.5b";
const temperature = number("temperature"), maxTokens = number("max-tokens"), seed = number("seed"), system = value("system");
try {
  const request = sealTextGenerationRequest({
    format: flags.has("json") ? "json" : "text",
    prompt,
    ...(system === undefined ? {} : { system }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(seed === undefined ? {} : { seed }),
  });
  const { client } = createOllamaTextProvider({ model, baseUrl: value("url") ?? process.env.HYPIT_OLLAMA_URL ?? "http://127.0.0.1:11434" });
  console.log(await generateOllamaText(client, { model }, request));
} catch (error) {
  console.error(error instanceof OllamaError ? `${error.code}: ${error.message}` : (error as Error).message);
  process.exit(1);
}
