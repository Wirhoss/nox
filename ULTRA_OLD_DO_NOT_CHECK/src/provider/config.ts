import { z } from 'zod';

const samplingParametersConfigSchema = z.object({
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(1).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().positive().optional(),
  stop: z.array(z.string()).optional(),
  seed: z.number().int().optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
});

const modelBaseConfigSchema = samplingParametersConfigSchema.extend({
  modelId: z.string(),
});

const textModelConfigSchema = modelBaseConfigSchema.extend({
  type: z.literal('text'),
  contextWindow: z.number().int().positive().optional(),
});

const modelConfigSchema = z.discriminatedUnion('type', [
  textModelConfigSchema
]);

type ModelConfig = z.infer<typeof modelConfigSchema>;

const providerBaseConfigSchema = z.object({
  baseUrl: z.string(),
  apiKey: z.string().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  modelConfigs: z.array(modelConfigSchema).optional(),
  retryDelayMs: z.number().nonnegative().optional(),
  timeoutMs: z.number().positive().optional(),
});

type ProviderBaseConfig = z.infer<typeof providerBaseConfigSchema>;

const textGenerateOptionsSchema = samplingParametersConfigSchema.extend({
  model: modelConfigSchema.optional(),
  signal: z.instanceof(AbortSignal).optional(),
  requestId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type TextGenerateOptions = z.infer<typeof textGenerateOptionsSchema>;

export {
  modelBaseConfigSchema,
  modelConfigSchema,
  providerBaseConfigSchema,
  samplingParametersConfigSchema,
  textGenerateOptionsSchema,
  textModelConfigSchema,
};

export type {
  ModelConfig,
  ProviderBaseConfig,
  TextGenerateOptions
};
