/**
 * The provider-neutral text-generation request. It names no service, model tag or address: the
 * Runtime Profile selects those through the Endpoint that fulfills `generate-text`.
 */
export type TextGenerationFormat = "text" | "json";

export type TextGenerationOptions = {
  readonly format: TextGenerationFormat;
  /** Sampling temperature. Omission keeps the serving model's own default. */
  readonly temperature?: number;
  /** Upper bound on generated tokens. Omission keeps the serving model's own default. */
  readonly maxTokens?: number;
  /** Sampling seed for repeatable variants on the same model and service. */
  readonly seed?: number;
};

export type TextGenerationRequest = TextGenerationOptions & {
  readonly prompt: string;
  readonly system?: string;
};

export const textGenerationLimits = {
  maxPromptCharacters: 32_000,
  maxSystemCharacters: 8_000,
  maxTemperature: 2,
  maxTokens: 8_192,
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown, subject: string): Readonly<Record<string, unknown>> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${subject} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[], subject: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  assert(unknown.length === 0, `${subject} does not accept ${unknown[0]}`);
}

function boundedText(value: unknown, maximum: number, subject: string): string {
  assert(typeof value === "string", `${subject} must be text`);
  assert(value.trim().length > 0, `${subject} is empty`);
  assert(value.length <= maximum, `${subject} exceeds ${maximum} characters`);
  return value;
}

/** Validate options only, so planning can check them before the prompt Text exists. */
export function verifyTextGenerationOptions(value: unknown, subject = "TextGenerationOptions"): TextGenerationOptions {
  const fields = record(value, subject);
  return optionsFrom(fields, subject);
}

function optionsFrom(fields: Readonly<Record<string, unknown>>, subject: string): TextGenerationOptions {
  const format = fields.format;
  assert(format === "text" || format === "json", `${subject}.format must be text or json`);
  const { temperature, maxTokens, seed } = fields;
  if (temperature !== undefined) {
    assert(typeof temperature === "number" && Number.isFinite(temperature)
      && temperature >= 0 && temperature <= textGenerationLimits.maxTemperature,
    `${subject}.temperature must be a number from 0 to ${textGenerationLimits.maxTemperature}`);
  }
  if (maxTokens !== undefined) {
    assert(typeof maxTokens === "number" && Number.isSafeInteger(maxTokens)
      && maxTokens > 0 && maxTokens <= textGenerationLimits.maxTokens,
    `${subject}.maxTokens must be an integer from 1 to ${textGenerationLimits.maxTokens}`);
  }
  if (seed !== undefined) {
    assert(typeof seed === "number" && Number.isSafeInteger(seed) && seed >= 0,
      `${subject}.seed must be a non-negative integer`);
  }
  return {
    format,
    ...(temperature === undefined ? {} : { temperature: temperature as number }),
    ...(maxTokens === undefined ? {} : { maxTokens: maxTokens as number }),
    ...(seed === undefined ? {} : { seed: seed as number }),
  };
}

export function sealTextGenerationOptions(value: TextGenerationOptions): TextGenerationOptions {
  const fields = record(value, "TextGenerationOptions");
  exactKeys(fields, ["format", "temperature", "maxTokens", "seed"], "TextGenerationOptions");
  return optionsFrom(fields, "TextGenerationOptions");
}

/** The complete request a Provider receives as Need constraints. */
export function verifyTextGenerationRequest(value: unknown, subject = "TextGenerationRequest"): TextGenerationRequest {
  const fields = record(value, subject);
  exactKeys(fields, ["prompt", "system", "format", "temperature", "maxTokens", "seed"], subject);
  const prompt = boundedText(fields.prompt, textGenerationLimits.maxPromptCharacters, `${subject}.prompt`);
  const system = fields.system === undefined
    ? undefined
    : boundedText(fields.system, textGenerationLimits.maxSystemCharacters, `${subject}.system`);
  return {
    ...optionsFrom(fields, subject),
    prompt,
    ...(system === undefined ? {} : { system }),
  };
}

export function sealTextGenerationRequest(value: TextGenerationRequest): TextGenerationRequest {
  return verifyTextGenerationRequest(value);
}
