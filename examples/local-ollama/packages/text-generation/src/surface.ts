import { assertAttributes, textAttribute } from "@hypit/hypit/markup";
import type { StructuredElement, StructuredSurfaceHandler, SurfaceRecordDraft, SurfaceResolvedReference } from "@hypit/hypit/markup";
import { canonicalize, sameType } from "@hypit/hypit/protocol";
import { sealText, textTypes } from "@hypit/hypit/text";

import { textGenerationFragment, textGenerationWithSystemFragment } from "./fragment.js";
import { textGenerationTypes } from "./manifest.js";
import { sealTextGenerationOptions, textGenerationLimits } from "./request.js";
import type { TextGenerationOptions } from "./request.js";

function reference(element: StructuredElement, name: string,
  resolveReference: (path: string) => SurfaceResolvedReference | undefined): SurfaceResolvedReference {
  const raw = element.attributes[name];
  if (typeof raw !== "object" || raw.kind !== "reference") throw new Error(`${element.name}.${name} must be a whole-value reference`);
  const value = resolveReference(raw.path);
  if (value === undefined) throw new Error(`${element.name}.${name} cannot resolve ${raw.path}`);
  if (!sameType(value.type, textTypes.text)) throw new Error(`${element.name}.${name} must reference Text`);
  return value;
}

function bodyText(element: StructuredElement): string {
  if (element.children.some((child) => child.kind === "element")) throw new Error(`${element.name} accepts text only`);
  const lines = element.children.map((child) => child.kind === "text" ? child.value : "").join("")
    .replaceAll("\r\n", "\n").split("\n");
  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();
  const indents = lines.filter((line) => line.trim()).map((line) => /^\s*/u.exec(line)?.[0].length ?? 0);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(indent).trimEnd()).join("\n");
}

function number(element: StructuredElement, name: string): number | undefined {
  const raw = element.attributes[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "" || !Number.isFinite(Number(raw))) {
    throw new Error(`${element.name}.${name} must be a number`);
  }
  return Number(raw);
}

function options(element: StructuredElement): TextGenerationOptions {
  const format = element.attributes.format ?? "text";
  if (format !== "text" && format !== "json") throw new Error(`${element.name}.format must be text or json`);
  const temperature = number(element, "temperature");
  const maxTokens = number(element, "max-tokens");
  const seed = number(element, "seed");
  return sealTextGenerationOptions({
    format,
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(seed === undefined ? {} : { seed }),
  });
}

/** Publish one generated Text. The Profile, not this Source, decides which model produces it. */
export const decodeTextGenerationSurface: StructuredSurfaceHandler = ({ element, resolveReference }) => {
  assertAttributes(element, ["id", "prompt", "system", "format", "temperature", "max-tokens", "seed"]);
  const id = textAttribute(element, "id");
  const records: SurfaceRecordDraft[] = [{
    id: `${id}.options`, type: textGenerationTypes.options,
    value: { kind: "inline", value: canonicalize(options(element)) }, range: element.range,
  }];
  const inputs: Record<string, SurfaceResolvedReference["ref"] | { kind: "record"; id: string }> = {
    options: { kind: "record", id: `${id}.options` },
  };
  if (element.attributes.prompt !== undefined) {
    if (bodyText(element).length > 0) throw new Error(`${element.name} takes its prompt from either prompt or its body, not both`);
    inputs.prompt = reference(element, "prompt", resolveReference).ref;
  } else {
    const prompt = bodyText(element);
    if (prompt.length === 0) throw new Error(`${element.name} requires a prompt reference or a prompt body`);
    if (prompt.length > textGenerationLimits.maxPromptCharacters) {
      throw new Error(`${element.name} prompt exceeds ${textGenerationLimits.maxPromptCharacters} characters`);
    }
    records.push({ id: `${id}.prompt`, type: textTypes.text,
      value: { kind: "inline", value: canonicalize(sealText(prompt)) }, range: element.range });
    inputs.prompt = { kind: "record", id: `${id}.prompt` };
  }
  const fragment = element.attributes.system === undefined ? textGenerationFragment : textGenerationWithSystemFragment;
  if (element.attributes.system !== undefined) inputs.system = reference(element, "system", resolveReference).ref;
  return {
    records,
    components: [{ id, fragment: fragment.id, inputs, outputs: { text: id }, range: element.range }],
    fragments: [fragment],
    exports: [id],
  };
};
