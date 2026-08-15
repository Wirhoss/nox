import type { z } from "zod";
import type { Provider } from "./provider";
import { OpenAICompletions } from "./providers";
import { createLogger } from "../logger";
import type { ModelConfig } from "./config";

const logger = createLogger('provider');

const builtinProvidersClasses = {
  [OpenAICompletions.configSchema.shape.type.value]: OpenAICompletions,
};
type ProviderClass = (typeof builtinProvidersClasses)[keyof typeof builtinProvidersClasses];
type ProviderConfig = z.infer<ProviderClass['configSchema']>;

class ProviderRegistry {
  private providerClasses: Record<string, ProviderClass> = {
    ...builtinProvidersClasses,
  };
  private providers: Record<string, Provider> = {};

  private initialized: boolean = false;

  constructor() {}

  public async init(configs: Record<string, ProviderConfig>): Promise<Record<string, Provider>> {
    if (this.initialized) {
      throw new Error('ProviderRegistry already initialized.');
    }
    this.initialized = true;

    try {
      const results = await Promise.allSettled(
        Object.entries(configs).map(([providerId, providerConfig]) =>
          this.initProvider(providerId, providerConfig),
        ),
      );
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value != null) {
          this.providers[result.value.providerId] = result.value.provider;
        }
      }
      const providerIds = Object.keys(this.providers);
      const modelCount = Object.values(this.providers)
        .reduce((total, provider) => total + provider.modelCount, 0);
      const metadata = { providers: providerIds, providerCount: providerIds.length, modelCount };
      if (providerIds.length === 0) {
        logger.warn(metadata, 'No active providers; starting Nox in degraded configuration mode.');
      } else {
        logger.info(metadata, 'Providers initialized successfully.');
      }
      return this.providers;
    } catch (error) {
      this.initialized = false;
      this.providers = {};
      throw error;
    }
  }

  private async initProvider(providerId: string, providerConfig: ProviderConfig): Promise<{ providerId: string; provider: Provider } | null> {
    const ProviderClass = this.providerClasses[providerConfig.type];
    if (!ProviderClass) {
      logger.warn({ providerId, type: providerConfig.type }, 'Unknown provider type, dropping it.');
      return null;
    }
    let provider: Provider;
    let availableModels: Set<string>;
    try {
      provider = new ProviderClass(providerConfig);
      availableModels = new Set(await provider.fetchModelIds());
    } catch (error) {
      logger.warn({ err: error, providerId }, 'Provider is unreachable, dropping it and its models.');
      return null;
    }
    if (availableModels.size === 0) {
      logger.warn({ providerId }, 'Provider has no available models, dropping it.');
      return null;
    }
    const configuredModels = new Map<string, ModelConfig>();
    for (const modelConfig of providerConfig.modelConfigs ?? []) {
      if (!availableModels.has(modelConfig.modelId)) {
        logger.warn(
          { providerId, modelId: modelConfig.modelId },
          'Configured model not available on provider, skipping.',
        );
        continue;
      }
      configuredModels.set(modelConfig.modelId, modelConfig);
    }
    const notConfiguredModels = [...availableModels].filter(modelId => !configuredModels.has(modelId));
    for (const modelId of notConfiguredModels) {
      configuredModels.set(modelId, { type: 'text', modelId });
    }
    for (const model of configuredModels.values()) {
      provider.addModelConfig(model);
    }
    return { providerId, provider };
  }
}