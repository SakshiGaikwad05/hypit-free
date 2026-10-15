import { canonicalize } from "@hypit/hypit/protocol";
import { plannedNeedInputs } from "@hypit/hypit/producer";
import type { CanonicalValue, StoredValue } from "@hypit/hypit/protocol";
import type { ProducerPackage } from "@hypit/hypit/producer";
import type { AdmissionPackage } from "@hypit/hypit/admission";
import { verifyText } from "@hypit/hypit/text";

import { textGenerationCapabilities, textGenerationProducers } from "./manifest.js";
import { sealTextGenerationRequest, verifyTextGenerationOptions } from "./request.js";

function inline(value: StoredValue, subject: string): CanonicalValue {
  if (value.kind !== "inline") throw new Error(`${subject} must be inline`);
  return value.value;
}

function text(value: StoredValue, subject: string): string {
  const item = inline(value, subject) as unknown as { value: string };
  verifyText(item);
  return item.value;
}

function request(inputs: Readonly<Record<string, { readonly value: StoredValue } | undefined>>, withSystem: boolean) {
  const options = verifyTextGenerationOptions(inline(inputs.options!.value, "TextGenerationOptions"));
  const prompt = text(inputs.prompt!.value, "prompt Text");
  const system = withSystem ? text(inputs.system!.value, "system Text") : undefined;
  return canonicalize(sealTextGenerationRequest({
    ...options,
    prompt,
    ...(system === undefined ? {} : { system }),
  }));
}

function plannedOptions(state: Parameters<NonNullable<ProducerPackage["plannedNeeds"]>[number]["plan"]>[0]["state"], step: string) {
  const operation = state.plan.steps.find((item) => item.id === step);
  const optionsRecord = operation?.inputs.options;
  const options = optionsRecord === undefined
    ? undefined
    : state.records.find((record) => record.id === optionsRecord)?.value;
  return options?.kind === "inline" ? options.value : undefined;
}

const plannedNeed = (producer: typeof textGenerationProducers.request) => ({
  producer,
  port: "text",
  capability: textGenerationCapabilities.generate,
  plan({ state, step }: Parameters<NonNullable<ProducerPackage["plannedNeeds"]>[number]["plan"]>[0]) {
    const options = plannedOptions(state, step);
    if (options === undefined) return undefined;
    // Prompt Text produced upstream is a pending slot until the Build evaluates it.
    return { constraints: options, pendingInputs: plannedNeedInputs(state, step) };
  },
  present(specification: { readonly constraints: CanonicalValue; readonly pendingInputs: readonly { readonly input: string }[] }) {
    const fields = specification.constraints !== null && typeof specification.constraints === "object"
      && !Array.isArray(specification.constraints)
      ? specification.constraints as Readonly<Record<string, CanonicalValue>>
      : {};
    return {
      fields: Object.fromEntries(Object.entries(fields)
        .filter(([name]) => ["format", "temperature", "maxTokens", "seed"].includes(name))
        .map(([name, value]) => [name, [value]])),
      references: {},
    };
  },
});

export const textGenerationComponent = {
  producers: [
    {
      producer: textGenerationProducers.request,
      handler: ({ inputs }) => ({ outputs: {}, needs: { text: request(inputs, false) } }),
    },
    {
      producer: textGenerationProducers.requestWithSystem,
      handler: ({ inputs }) => ({ outputs: {}, needs: { text: request(inputs, true) } }),
    },
  ],
  plannedNeeds: [
    plannedNeed(textGenerationProducers.request),
    plannedNeed(textGenerationProducers.requestWithSystem),
  ],
} satisfies ProducerPackage & AdmissionPackage;
