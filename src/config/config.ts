import { createLogger } from '../logger';

import { getEnvConfig } from './env';
import { ConfigError } from './error';
import { loadSection, parseDocument, writeJson } from './loader';
import { sections } from './sections';

import type { EnvConfig } from './env';
import type { ConfigSection } from './section';
import type { ConfigKey, ConfigMap } from './sections';

const logger = createLogger('config');

function erase(key: ConfigKey): ConfigSection<unknown> {
  return sections[key] as unknown as ConfigSection<unknown>;
}

class Config {
  static #env?: EnvConfig;
  static readonly #values = new Map<ConfigKey, unknown>();

  public static async init(env: EnvConfig = getEnvConfig()): Promise<void> {
    if (Config.#env) return;

    for (const key of Object.keys(sections) as ConfigKey[]) {
      Config.#values.set(key, await loadSection(erase(key), env.configDir));
    }

    Config.#env = env;
    logger.info(
      { configDir: env.configDir, sections: Object.keys(sections) },
      'Configuration loaded.',
    );
  }

  public static get<K extends ConfigKey>(key: K): ConfigMap[K] {
    const value = Config.#values.get(key);
    if (value === undefined) {
      throw new Error('Config not initialized. Call Config.init() before reading configuration.');
    }
    return value as ConfigMap[K];
  }

  public static env(): EnvConfig {
    if (!Config.#env) {
      throw new Error('Config not initialized. Call Config.init() before reading configuration.');
    }
    return Config.#env;
  }

  public static async update<K extends ConfigKey>(
    key: K,
    next: ConfigMap[K],
  ): Promise<{ restartRequired: boolean; value: ConfigMap[K] }> {
    const section = erase(key);
    const filePath = `${Config.env().configDir}/${section.name}`;

    if (section.kind !== 'file') {
      throw new ConfigError('unwritable', filePath, 'is a directory; update its entries instead.');
    }

    const { value: parsed } = parseDocument(section.schema, next, filePath);
    const previous = Config.#values.get(key);
    const value = section.merge ? section.merge(previous, parsed) : parsed;

    await writeJson(filePath, value);
    Config.#values.set(key, value);

    return { restartRequired: section.applies === 'restart', value: value as ConfigMap[K] };
  }

  public static reset(): void {
    Config.#env = undefined;
    Config.#values.clear();
  }
}

export {
  Config,
};
