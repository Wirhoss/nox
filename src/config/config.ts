import { join } from 'node:path';

import { type Logger, silentLogger } from '../logger/logger';
import { Mutex } from '../utils/mutex';
import { ConfigError } from './error';
import { type LoaderContext, loadSection, updateSection } from './loader';
import { type ConfigKey, type ConfigMap, sections } from './sections';

import type { ContributionReader } from '../extensions/contribution';
import type { EnvConfig } from './env';
import type { ConfigSection } from './section';

interface ConfigOptions {
  logger?: Logger;
}

interface ConfigUpdate<T> {
  restartRequired: boolean;
  value: T;
}

function erase(key: ConfigKey): ConfigSection {
  return sections[key] as ConfigSection;
}

function isDeferred(section: ConfigSection): boolean {
  return section.kind === 'contribution';
}

/**
 * The one module that administers configuration. Every section is described as
 * data elsewhere; this holds the values, validates every write against the
 * section's own schema and reports whether the change needs a restart.
 *
 * Loading happens in two phases, and the split is real rather than an
 * implementation detail. Static sections are read first because the process
 * needs them to exist at all — the log level and the database path are required
 * before anything can be started. Sections backed by a contribution point cannot
 * be read yet, because the schemas that validate them arrive with the extensions
 * that have not activated. `resolve` is the second phase, and until it runs
 * those sections have no value rather than a wrong one.
 */
class Config {
  readonly #context: LoaderContext;
  readonly #env: EnvConfig;
  readonly #updates = new Mutex();
  readonly #values: Map<ConfigKey, unknown>;

  #contributions?: ContributionReader;

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
      const section = erase(key);
      if (isDeferred(section)) continue;
      values.set(key, await loadSection(section, context));
    }

    context.logger.info(
      { configDir: env.configDir, sections: [...values.keys()] },
      'Configuration loaded.',
    );
    return new Config(env, context, values);
  }

  public get env(): EnvConfig {
    return this.#env;
  }

  /** The sections holding a value. Deferred ones appear only after `resolve`. */
  public get loaded(): readonly ConfigKey[] {
    return Object.freeze([...this.#values.keys()].sort((a, b) => a.localeCompare(b)));
  }

  /**
   * The second phase: reads every section whose schema is assembled from what
   * extensions contributed. Re-running it re-reads them, which is what a
   * contribution registered or disposed after startup requires.
   */
  public async resolve(contributions: ContributionReader): Promise<void> {
    this.#contributions = contributions;

    return this.#updates.run(async () => {
      const resolved: ConfigKey[] = [];
      for (const key of Object.keys(sections) as ConfigKey[]) {
        const section = erase(key);
        if (!isDeferred(section)) continue;
        this.#values.set(key, await loadSection(section, this.#context, contributions));
        resolved.push(key);
      }

      this.#context.logger.info({ sections: resolved }, 'Contributed configuration resolved.');
    });
  }

  public get<K extends ConfigKey>(key: K): ConfigMap[K] {
    if (!this.#values.has(key)) {
      throw new ConfigError(
        'unresolved',
        join(this.#context.configDir, erase(key).name),
        'has not been resolved yet: call Config.resolve() once extensions have activated.',
      );
    }
    return this.#values.get(key) as ConfigMap[K];
  }

  /**
   * Updates are serialized so the file on disk and the value held here always
   * describe the same write: concurrent callers would otherwise land in one
   * order on disk and another in memory.
   */
  public async update<K extends ConfigKey>(
    key: K,
    next: ConfigMap[K],
  ): Promise<ConfigUpdate<ConfigMap[K]>> {
    const section = erase(key);

    return this.#updates.run(async () => {
      const value = await updateSection(
        section,
        this.#context,
        next,
        this.#values.get(key),
        section.kind === 'contribution' ? this.#reader(key) : undefined,
      );

      this.#values.set(key, value);
      return { restartRequired: section.applies === 'restart', value: value as ConfigMap[K] };
    });
  }

  #reader(key: ConfigKey): ContributionReader {
    if (this.#contributions === undefined) {
      throw new ConfigError(
        'unresolved',
        join(this.#context.configDir, erase(key).name),
        'cannot be written before Config.resolve() has supplied the contribution registry.',
      );
    }
    return this.#contributions;
  }
}

export { Config };

export type { ConfigOptions, ConfigUpdate };
