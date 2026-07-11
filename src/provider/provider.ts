import { z } from "zod";

import type { Message, Tool } from "../types";
import type { MessageContentStream } from "./messageContentStream";

const samplingParametersSchema = z.object({
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(1).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().positive().optional(),
  stop: z.array(z.string()).optional(),
  seed: z.number().int().optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
});


const modelBaseSchema = samplingParametersSchema.extend({
  modelId: z.string(),
});

const textModelSchema = modelBaseSchema.extend({
  type: z.literal("text"),
  contextWindow: z.number().int().positive().optional(),
});

const modelSchema = z.discriminatedUnion("type", [
  textModelSchema
]);

type Model = z.infer<typeof modelSchema>;

const providerBaseConfigSchema = z.object({
  baseUrl: z.string(),
  apiKey: z.string().optional(),
  models: z.array(modelSchema).optional(),
  timeoutMs: z.number().positive().optional(),
});

type ProviderBaseConfig = z.infer<typeof providerBaseConfigSchema>;

// the model carries its default sampling parameters; any set here override them per call
const textGenerateOptionsSchema = samplingParametersSchema.extend({
  model: modelSchema.optional(),
  signal: z.instanceof(AbortSignal).optional(),
  requestId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type TextGenerateOptions = z.infer<typeof textGenerateOptionsSchema>;

abstract class BaseProvider {
  static readonly configSchema = providerBaseConfigSchema;

  protected baseUrl: string;
  protected apiKey?: string;
  protected timeoutMs?: number;

  protected models: Record<string, Model> = {};

  constructor(config: ProviderBaseConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;
  }

  public fetchModels(): Promise<string[]> {
    return Promise.resolve([]);
  }

  public addModel(model: Model): void {
    this.models[model.modelId] = model;
  }

  public getModel(modelId: string): Model | undefined {
    return this.models[modelId];
  }

  public get modelCount(): number {
    return Object.keys(this.models).length;
  }
}

interface ChatProvider extends BaseProvider {
  getMessageStream(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts?: TextGenerateOptions,
  ): MessageContentStream;
}

type Provider = ChatProvider;

export {
  modelSchema,
  BaseProvider,
  providerBaseConfigSchema,
  samplingParametersSchema,
  textGenerateOptionsSchema,
  textModelSchema,
};

export type {
  Provider,
  ChatProvider,
  Model,
  ProviderBaseConfig,
  TextGenerateOptions,
};