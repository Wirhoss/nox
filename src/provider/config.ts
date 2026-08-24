import { z } from 'zod';

import { SecretHandle, secretRefSchema } from '../config/secrets';
import { httpUrlSchema } from '../config/url';
import { CONTENT_MODALITIES, type ContentModality } from '../content/content';

import type { ArtifactOutputPublisher } from '../artifact/output';

const samplingParametersConfigSchema = z.object({
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  seed: z.number().int().optional(),
  stop: z.array(z.string()).optional(),
  temperature: z.number().min(0).max(1).optional(),
  topK: z.number().int().positive().optional(),
  topP: z.number().min(0).max(1).optional(),
});

const requiredChatModalities = (direction: 'input' | 'output') =>
  z
    .array(z.enum(CONTENT_MODALITIES))
    .min(1)
    .refine((modalities) => modalities.includes('text'), {
      message: `Text ${direction} is required by the chat model interface.`,
    });

const modelInputModalitiesSchema = requiredChatModalities('input');
const modelOutputModalitiesSchema = requiredChatModalities('output');
const modelBaseConfigSchema = samplingParametersConfigSchema.extend({
  /** Modalities the model accepts in one chat turn; defaults are text-only. */
  inputModalities: modelInputModalitiesSchema.default((): ContentModality[] => ['text']),
  modelId: z.string(),
  /** Modalities the model can generate. The current chat contract requires text. */
  outputModalities: modelOutputModalitiesSchema.default((): ContentModality[] => ['text']),
  /** @deprecated Accepted while old provider configurations migrate. */
  type: z.literal('text').optional(),
});

const chatModelConfigSchema = modelBaseConfigSchema.extend({
  contextWindow: z.number().int().positive().optional(),
});

const modelConfigSchema = chatModelConfigSchema;

type ModelConfig = z.infer<typeof modelConfigSchema>;

function modelInputModalities(model: ModelConfig): readonly ContentModality[] {
  return model.inputModalities;
}

function modelAcceptsInput(model: ModelConfig, modality: ContentModality): boolean {
  return modelInputModalities(model).includes(modality);
}

function modelProducesOutput(model: ModelConfig, modality: ContentModality): boolean {
  return model.outputModalities.includes(modality);
}

const providerConfigShape = {
  // Validated rather than taken as a string: it is concatenated into every
  // request URL, and it is one of the few configured values logged verbatim
  // when a request never reaches the provider.
  baseUrl: httpUrlSchema('The HTTP(S) base URL of the provider endpoint.'),
  maxRetries: z.number().int().nonnegative().default(2),
  maxRetryDelayMs: z.number().nonnegative().default(30_000),
  modelConfigs: z.array(modelConfigSchema).optional(),
  retryDelayMs: z.number().nonnegative().default(500),
  timeoutMs: z.number().positive().optional(),
};

/**
 * What `providers.json` may contain. `apiKey` accepts a reference and never a
 * literal: the file says which managed secret this provider uses, and the value
 * itself stays in the store.
 *
 * Per instance, because that is what a provider is. Two entries of one kind
 * routinely talk to two services with two credentials, so the ID belongs to the
 * entry rather than to the adapter that reads it.
 */
const providerBaseConfigSchema = z.object({
  ...providerConfigShape,
  apiKey: secretRefSchema.optional(),
});

/** Factories receive the same validated shape after the host resolves its references. */
const providerRuntimeConfigSchema = z.object({
  ...providerConfigShape,
  apiKey: z.instanceof(SecretHandle).optional(),
});

type ProviderBaseConfig = z.infer<typeof providerBaseConfigSchema>;
type ProviderBaseConfigInput = z.input<typeof providerBaseConfigSchema>;
type ProviderRuntimeConfigInput = z.input<typeof providerRuntimeConfigSchema>;

const textGenerateOptionsSchema = samplingParametersConfigSchema.extend({
  metadata: z.record(z.string(), z.unknown()).optional(),
  model: modelConfigSchema.optional(),
  requestId: z.string().optional(),
  signal: z.instanceof(AbortSignal).optional(),
  /**
   * The zone timestamps in this request are written in. It travels with the
   * request rather than sitting in an adapter's configuration because it is one
   * installation-wide answer, and two adapters disagreeing about what time it is
   * would be two different conversations about the same day.
   */
  timeZone: z.string().min(1).optional(),
});

interface TextGenerateOptions extends z.infer<typeof textGenerateOptionsSchema> {
  /** Present only for a user-facing run; internal title and compaction calls cannot publish files. */
  readonly artifactOutput?: ArtifactOutputPublisher;
}

export {
  chatModelConfigSchema,
  modelAcceptsInput,
  modelBaseConfigSchema,
  modelConfigSchema,
  modelInputModalities,
  modelInputModalitiesSchema,
  modelOutputModalitiesSchema,
  modelProducesOutput,
  providerBaseConfigSchema,
  providerRuntimeConfigSchema,
  samplingParametersConfigSchema,
  textGenerateOptionsSchema,
};

export type {
  ModelConfig,
  ProviderBaseConfig,
  ProviderBaseConfigInput,
  ProviderRuntimeConfigInput,
  TextGenerateOptions,
};
