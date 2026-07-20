import { getAppConfig, appConfigSchema } from './app';
import { getBlueprintsConfig, blueprintsConfigSchema } from './blueprint';
import { getEnvConfig, envConfigSchema } from './env';
import { getProvidersConfig, providersConfigSchema } from './provider';
import { getToolsConfig, toolsConfigSchema } from './tools';

import type { AppConfig } from './app';
import type { BlueprintsConfig } from './blueprint';
import type { EnvConfig } from './env';
import type { ProvidersConfig } from './provider';
import type { ToolsConfig } from './tools';

export type ConfigType = {
  app: AppConfig;
  env: EnvConfig;
  providers: ProvidersConfig;
  tools: ToolsConfig;
  blueprints: BlueprintsConfig;
};

export class Config {
  private static config: ConfigType;

  public static async init(): Promise<void> {
    const envConfig = getEnvConfig();
    const appConfig = await getAppConfig(envConfig);
    const providersConfig = await getProvidersConfig(envConfig);
    const toolsConfig = await getToolsConfig(envConfig);
    const blueprintsConfig = await getBlueprintsConfig(envConfig);
    if (!Config.config) {
      Config.config = {
        env: envConfig,
        app: appConfig,
        providers: providersConfig,
        tools: toolsConfig,
        blueprints: blueprintsConfig,
      };
    };
  }

  public static get<K extends keyof ConfigType>(key: K): ConfigType[K] {
    if (!Config.config) {
      throw new Error('Config not initialized. Call Config.init() before accessing config values.');
    }
    return Config.config[key];
  }
}

export { envConfigSchema, appConfigSchema, blueprintsConfigSchema, providersConfigSchema, toolsConfigSchema };
export type { AppConfig, BlueprintsConfig, EnvConfig, ToolsConfig };
