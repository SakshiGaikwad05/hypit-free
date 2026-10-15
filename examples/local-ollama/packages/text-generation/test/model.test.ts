import assert from "node:assert/strict";
import test from "node:test";
import type { StructuredElement, SurfaceResolvedReference } from "@hypit/hypit/markup";
import { textTypes } from "@hypit/hypit/text";

import {
  decodeTextGenerationSurface, textGenerationComponent, textGenerationFragment, textGenerationWithSystemFragment,
  verifyTextGenerationRequest,
} from "../src/index.js";

const range = { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } };

function element(attributes: StructuredElement["attributes"], body = ""): StructuredElement {
  return {
    kind: "element", name: "llm:Generate", attributes, range: range as never,
    children: body === "" ? [] : [{ kind: "text", value: body, range } as never],
  };
}

const textRef = (path: string): SurfaceResolvedReference => ({
  path, ref: { kind: "record", id: path } as never, type: textTypes.text,
});

async function decode(value: StructuredElement, references: Record<string, SurfaceResolvedReference> = {}) {
  return await decodeTextGenerationSurface({
    element: value, resolveReference: (path: string) => references[path],
  } as never);
}

test("a body prompt becomes an ordinary Text record and the generated Text is published under the bare id", async () => {
  const output = await decode(element({ id: "hook", temperature: "0.8", "max-tokens": "60", seed: "1" },
    "\n    Write one opening line.\n      Keep it short.\n  "));
  assert.deepEqual(output.records.map((item) => item.id), ["hook.options", "hook.prompt"]);
  assert.deepEqual(output.records[0]!.value, { kind: "inline", value: { format: "text", maxTokens: 60, seed: 1, temperature: 0.8 } });
  assert.deepEqual(output.records[1]!.value, { kind: "inline", value: { value: "Write one opening line.\n  Keep it short." } });
  assert.equal(output.components[0]!.fragment, textGenerationFragment.id);
  assert.deepEqual(output.components[0]!.outputs, { text: "hook" });
  assert.deepEqual(output.exports, ["hook"]);
});

test("prompt and system references select the system Fragment; ambiguous or invalid authoring is refused", async () => {
  const references = { hook: textRef("hook"), rules: textRef("rules") };
  const output = await decode(element({
    id: "rewrite", prompt: { kind: "reference", path: "hook" }, system: { kind: "reference", path: "rules" }, format: "json",
  } as never), references);
  assert.equal(output.components[0]!.fragment, textGenerationWithSystemFragment.id);
  assert.deepEqual(Object.keys(output.components[0]!.inputs).sort(), ["options", "prompt", "system"]);
  await assert.rejects(decode(element({ id: "x", prompt: { kind: "reference", path: "hook" } } as never, "also a body"), references), /not both/u);
  await assert.rejects(decode(element({ id: "x" })), /requires a prompt/u);
  await assert.rejects(decode(element({ id: "x", format: "yaml" }, "p")), /format must be text or json/u);
  await assert.rejects(decode(element({ id: "x", temperature: "hot" }, "p")), /temperature must be a number/u);
  await assert.rejects(decode(element({ id: "x", "max-tokens": "0" }, "p")), /maxTokens/u);
  await assert.rejects(decode(element({ id: "x", model: "qwen2.5:1.5b" } as never, "p")), /model/u);
});

test("the Producer turns graph Text into one complete provider-neutral request", () => {
  const inline = (value: unknown) => ({ value: { kind: "inline" as const, value: value as never } });
  const plain = textGenerationComponent.producers[0]!;
  const withSystem = textGenerationComponent.producers[1]!;
  const request = plain.handler({ inputs: {
    prompt: inline({ value: "Write a hook" }), options: inline({ format: "text", seed: 7 }),
  } } as never) as { needs: { text: unknown } };
  assert.deepEqual(verifyTextGenerationRequest(request.needs.text), { format: "text", seed: 7, prompt: "Write a hook" });
  const system = withSystem.handler({ inputs: {
    system: inline({ value: "House style" }), prompt: inline({ value: "Write a hook" }), options: inline({ format: "json" }),
  } } as never) as { needs: { text: unknown } };
  assert.deepEqual(verifyTextGenerationRequest(system.needs.text), { format: "json", prompt: "Write a hook", system: "House style" });
  assert.throws(() => plain.handler({ inputs: {
    prompt: inline({ value: "   " }), options: inline({ format: "text" }),
  } } as never), /prompt is empty/u);
});
