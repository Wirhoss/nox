import { createLogger } from '../logger';

import { OpenAICompletions } from "./openAICompletions";

import type { Model, Provider } from "./provider";
import type z from 'zod';

const logger = createLogger("provider");

const builtinProviderBlueprints = {
  [OpenAICompletions.configSchema.shape.type.value]: OpenAICompletions,
};

type ProviderBlueprint = (typeof builtinProviderBlueprints)[keyof typeof builtinProviderBlueprints];
type ProviderConfig = z.infer<ProviderBlueprint["configSchema"]>;

class ProviderManager {
  private static _instance: ProviderManager;

  private providers: Record<string, Provider> = {};
  private providerBlueprints: Record<string, ProviderBlueprint> = {
    ...builtinProviderBlueprints,
  };

  private initialized: boolean = false;

  private constructor() { }

  public static get instance(): ProviderManager {
    if (!ProviderManager._instance) {
      ProviderManager._instance = new ProviderManager();
    }
    return ProviderManager._instance;
  }

  public getProvider(providerId: string): Provider | null {
    return this.providers[providerId] || null;
  }

  public registerProviderBlueprint(blueprint: ProviderBlueprint): void {
    if (this.initialized) {
      throw new Error("Cannot register provider blueprint after initialization.");
    }
    this.providerBlueprints[blueprint.configSchema.shape.type.value] = blueprint;
  }

  public async init(
    providersConfig: Record<string, ProviderConfig>
  ): Promise<Record<string, Provider>> {
    if (this.initialized) {
      throw new Error("ProviderManager already initialized.");
    }
    this.initialized = true;

    try {
      const results = await Promise.allSettled(
        Object.entries(providersConfig).map(([providerId, providerConfig]) =>
          this.initProvider(providerId, providerConfig),
        ),
      );
      for (const result of results) {
        if (result.status === "fulfilled" && result.value != null) {
          this.providers[result.value.providerId] = result.value.provider;
        }
      }

      if (!Object.values(this.providers).length) {
        throw new Error("No valid providers after init.");
      }
      const providerIds = Object.keys(this.providers);
      const modelCount = Object.values(this.providers)
        .reduce((total, provider) => total + provider.modelCount, 0);
      logger.info(
        { providers: providerIds, providerCount: providerIds.length, modelCount },
        "Providers initialized successfully.",
      );
      return this.providers;
    } catch (error) {
      this.initialized = false;
      this.providers = {};
      throw error;
    }

  }

  private async initProvider(
    providerId: string,
    providerConfig: ProviderConfig,
  ): Promise<{ providerId: string; provider: Provider } | null> {
    const ProviderClass = this.providerBlueprints[providerConfig.type];
    if (!ProviderClass) {
      logger.warn({ providerId, type: providerConfig.type }, "Unknown provider type, dropping it.");
      return null;
    }

    let provider: Provider;
    let availableModels: Set<string>;
    try {
      provider = new ProviderClass(providerConfig);
      availableModels = new Set(await provider.fetchModels());
    } catch (error) {
      logger.warn({ err: error, providerId }, "Provider is unreachable, dropping it and its models.");
      return null;
    }

    if (availableModels.size === 0) {
      logger.warn({ providerId }, "Provider has no available models, dropping it.");
      return null;
    }

    const configuredModels = new Map<string, Model>();

    for(const modelConfig of providerConfig.models ?? []) {
      if (!availableModels.has(modelConfig.modelId)) {
        logger.warn(
          { providerId, modelId: modelConfig.modelId },
          "Configured model not available on provider, skipping.",
        );
        continue;
      }
      configuredModels.set(modelConfig.modelId, modelConfig);
    }

    const notConfiguredModels = [...availableModels].filter(modelId => !configuredModels.has(modelId));

    for (const modelId of notConfiguredModels) {
      configuredModels.set(modelId, { type: "text", modelId });
    }

    for (const model of configuredModels.values()) {
      provider.addModel(model);
    }

    return { providerId, provider };
  }
}

export {
  ProviderManager,
  builtinProviderBlueprints,
};