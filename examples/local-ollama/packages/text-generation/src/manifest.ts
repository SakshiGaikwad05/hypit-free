import { textDependency, textTypes } from "@hypit/hypit/text";
import type { CapabilityRef, ModuleManifest, ProducerRef, TypeRef } from "@hypit/hypit/protocol";

export const textGenerationModuleRef = { name: "@local/text-generation", version: "1" } as const;

export const textGenerationTypes = {
  options: { module: textGenerationModuleRef, name: "TextGenerationOptions" },
} satisfies Record<string, TypeRef>;

export const textGenerationCapabilities = {
  generate: { module: textGenerationModuleRef, name: "generate-text" },
} satisfies Record<string, CapabilityRef>;

export const textGenerationProducers = {
  request: { module: textGenerationModuleRef, name: "request-text" },
  requestWithSystem: { module: textGenerationModuleRef, name: "request-text-with-system" },
} satisfies Record<string, ProducerRef>;

const need = [{
  name: "text",
  capability: textGenerationCapabilities.generate,
  returns: textTypes.text,
}];

export const textGenerationManifest: ModuleManifest = {
  format: "hypit.module@1",
  name: textGenerationModuleRef.name,
  version: textGenerationModuleRef.version,
  dependencies: [textDependency],
  types: [{ name: textGenerationTypes.options.name }],
  capabilities: [{ name: textGenerationCapabilities.generate.name, returns: textTypes.text }],
  producers: [
    {
      name: textGenerationProducers.request.name,
      inputs: [
        { name: "prompt", type: textTypes.text },
        { name: "options", type: textGenerationTypes.options },
      ],
      outputs: [],
      needs: need,
    },
    {
      name: textGenerationProducers.requestWithSystem.name,
      inputs: [
        { name: "system", type: textTypes.text },
        { name: "prompt", type: textTypes.text },
        { name: "options", type: textGenerationTypes.options },
      ],
      outputs: [],
      needs: need,
    },
  ],
};

export const textGenerationMarkupSurfaces = [{
  name: "generate",
  tag: "Generate",
  mode: "structured",
  outputs: [textTypes.text, textGenerationTypes.options],
  vocabulary: {
    summary: "Generates one Text with the text model selected by the Runtime Profile, such as a local Ollama model.",
    attributes: [
      { name: "id", kind: "identifier", required: true,
        summary: "Names the generated Text, published under the bare id." },
      { name: "prompt", kind: "reference", required: false, accepts: [textTypes.text],
        summary: "Selects the prompt Text. Omit it to write the prompt as the element body instead." },
      { name: "system", kind: "reference", required: false, accepts: [textTypes.text],
        summary: "Selects optional system instructions, such as a house style or output contract." },
      { name: "format", kind: "literal", required: false, values: ["text", "json"],
        summary: "Requests plain text (default) or one JSON document, which the Provider validates before publishing." },
      { name: "temperature", kind: "literal", required: false,
        summary: "Sampling temperature from 0 to 2; omission keeps the model default." },
      { name: "max-tokens", kind: "literal", required: false,
        summary: "Upper bound on generated tokens; omission keeps the model default." },
      { name: "seed", kind: "literal", required: false,
        summary: "Non-negative integer seed. Give variants different seeds for distinct, repeatable results." },
    ],
    text: "When `prompt` is omitted, the element body is the prompt, with surrounding blank lines and shared indentation removed.",
    ports: [
      { name: "", type: textTypes.text, summary: "The generated Text, addressed by the element's own id." },
    ],
    example: `<llm:Generate id="hook" system={house-style} temperature="0.8" max-tokens="80" seed="1">
  Write one scroll-stopping opening line for a 20-second video about cold brew coffee.
</llm:Generate>`,
    notes: [
      "The model tag, service address and timeouts belong to the Runtime Profile Endpoint, never to Source.",
      "The generated Text is an ordinary graph value: it can feed captions, on-screen text, image prompts or speech input.",
      "Generation runs during a Build. A Script's Segments are parsed when Source compiles, so generated text cannot become Script structure in the same Run.",
    ],
  },
}] as const;
