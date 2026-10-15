import { sealGraphFragment } from "@hypit/hypit/author";
import { textTypes } from "@hypit/hypit/text";

import { textGenerationProducers, textGenerationTypes } from "./manifest.js";

const input = (name: string) => ({ kind: "fragment-input" as const, name });
const operation = (id: string) => ({ kind: "fragment-operation" as const, operation: id });

export const textGenerationFragment = sealGraphFragment({
  inputs: [{ name: "prompt", type: textTypes.text }, { name: "options", type: textGenerationTypes.options }],
  operations: [{
    id: "generate", producer: textGenerationProducers.request,
    inputs: { prompt: input("prompt"), options: input("options") },
    result: { kind: "need", name: "text" },
  }],
  exports: [{ name: "text", type: textTypes.text, root: operation("generate") }],
});

export const textGenerationWithSystemFragment = sealGraphFragment({
  inputs: [{ name: "system", type: textTypes.text }, { name: "prompt", type: textTypes.text },
    { name: "options", type: textGenerationTypes.options }],
  operations: [{
    id: "generate", producer: textGenerationProducers.requestWithSystem,
    inputs: { system: input("system"), prompt: input("prompt"), options: input("options") },
    result: { kind: "need", name: "text" },
  }],
  exports: [{ name: "text", type: textTypes.text, root: operation("generate") }],
});
