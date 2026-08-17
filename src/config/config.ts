import { type Logger, silentLogger } from '../logger/logger';
import { type ConfigKey, type ConfigMap, sections } from './sections';

import type { EnvConfig } from './env';
import type { LoaderContext } from './loader';

interface ConfigOptions {
  logger?: Logger;
}

interface ConfigUpdate<T> {
  restartRequired: boolean;
  value: T;
}

class Config {
  readonly #context: LoaderContext;
  readonly #env: EnvConfig;
  readonly #values: Map<ConfigKey, unknown>;

  private constructor(env: EnvConfig, context: LoaderContext, values: Map<ConfigKey, unknown>) {
    this.#context = context;
    this.#env = env;
    this.#values = values;
  }

  public static async load(env: EnvConfig, options: ConfigOptions = {}): Promise<Config> {
    const context: LoaderContext = {
      configDir: env.configDir,
      logger: (options.logger ?? silentLogger).child('config'),
    };

    const values = new Map<ConfigKey, unknown>();
    for (const key of Object.keys(sections) as ConfigKey[]) {
      values.set(key, await sections[key].load(context));
    }

    context.logger.info(
      { configDir: env.configDir, sections: Object.keys(sections) },
      'Configuration loaded.',
    );
    return new Config(env, context, values);
  }

  public get env(): EnvConfig {
    return this.#env;
  }

  public get<K extends ConfigKey>(key: K): ConfigMap[K] {
    return this.#values.get(key) as ConfigMap[K];
  }

  public async update<K extends ConfigKey>(
    key: K,
    next: ConfigMap[K],
  ): Promise<ConfigUpdate<ConfigMap[K]>> {
    const section = sections[key];
    const value = (await section.update(this.#context, next)) as ConfigMap[K];

    this.#values.set(key, value);
    return { restartRequired: section.applies === 'restart', value };
  }
}

export { Config };

export type { ConfigOptions, ConfigUpdate };
