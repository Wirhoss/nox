import {
  providerBaseConfigSchema,
  type ModelConfig,
  type ProviderBaseConfig,
  type TextGenerateOptions,
} from './config';

import type { Tool } from '../tool';
import type { Message } from './message';
import type { ProviderStream } from './stream';

abstract class BaseProvider {
  static readonly configSchema = providerBaseConfigSchema;

  protected baseUrl: string;
  protected apiKey?: string;
  protected timeoutMs?: number;

  protected modelConfigs: Record<string, ModelConfig> = {};

  constructor(config: ProviderBaseConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;

    for (const modelConfig of config.modelConfigs ?? []) {
      this.addModelConfig(modelConfig);
    }
  }

  public abstract fetchModelIds(): Promise<string[]>;

  public addModelConfig(modelConfig: ModelConfig): void {
    if (this.modelConfigs[modelConfig.modelId]) {
      throw new Error(`Model config for modelId ${modelConfig.modelId} already exists.`);
    }
    this.modelConfigs[modelConfig.modelId] = modelConfig;
  }

  public getModelConfig(modelId: string): ModelConfig | undefined {
    return this.modelConfigs[modelId];
  }

  public get modelCount(): number {
    return Object.keys(this.modelConfigs).length;
  }
}

interface ChatProvider extends BaseProvider {
  getMessageStream(
    systemPrompt: string,
    messageHistory: Message[],
    tools: Tool[],
    opts?: TextGenerateOptions,
  ): ProviderStream;
}

type Provider = ChatProvider;

export {
  BaseProvider,
};

export type {
  ChatProvider,
  Provider,
};
