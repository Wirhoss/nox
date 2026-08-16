import { z } from "zod";

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
  type: z.literal("text"),
});

const modelConfigSchema = z.discriminatedUnion("type", [textModelConfigSchema]);

type ModelConfig = z.infer<typeof modelConfigSchema>;

const providerBaseConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string(),
  maxRetries: z.number().int().nonnegative().optional(),
  modelConfigs: z.array(modelConfigSchema).optional(),
  retryDelayMs: z.number().nonnegative().optional(),
  timeoutMs: z.number().positive().optional(),
});

type ProviderBaseConfig = z.infer<typeof providerBaseConfigSchema>;

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
  samplingParametersConfigSchema,
  textGenerateOptionsSchema,
  textModelConfigSchema,
};

export type { ModelConfig, ProviderBaseConfig, TextGenerateOptions };
