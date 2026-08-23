import { z } from 'zod';

import { SecretHandle, secretRefSchema } from '../config/secrets';
import { httpUrlSchema } from '../config/url';

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

const modelBaseConfigSchema = samplingParametersConfigSchema.extend({
  modelId: z.string(),
});

const textModelConfigSchema = modelBaseConfigSchema.extend({
  contextWindow: z.number().int().positive().optional(),
  type: z.literal('text'),
});

const modelConfigSchema = z.discriminatedUnion('type', [textModelConfigSchema]);

type ModelConfig = z.infer<typeof modelConfigSchema>;

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
});

type TextGenerateOptions = z.infer<typeof textGenerateOptionsSchema>;

export {
  modelBaseConfigSchema,
  modelConfigSchema,
  providerBaseConfigSchema,
  providerRuntimeConfigSchema,
  samplingParametersConfigSchema,
  textGenerateOptionsSchema,
  textModelConfigSchema,
};

export type {
  ModelConfig,
  ProviderBaseConfig,
  ProviderBaseConfigInput,
  ProviderRuntimeConfigInput,
  TextGenerateOptions,
};
