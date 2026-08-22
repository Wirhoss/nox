import { join } from 'node:path';

import { type Logger, silentLogger } from '../logger/logger';
import { Mutex } from '../utils/mutex';
import { ConfigError } from './error';
import { type LoaderContext, loadSection, removeEntry, updateEntry, updateSection } from './loader';
import { type ConfigKey, type ConfigMap, sections, type Sections } from './sections';

import type { ContributionReader } from '../extensions/contribution';
import type { EnvConfig } from './env';
import type { ConfigSection, ContributionSection, DirectorySection } from './section';

interface ConfigOptions {
  logger?: Logger;
}

interface ConfigUpdate<T> {
  restartRequired: boolean;
  value: T;
}

/** The sections whose value is a set of separately addressable entries. */
type DirectoryKey = {
  [K in ConfigKey]: Sections[K]['kind'] extends 'directory' ? K : never;
}[ConfigKey];

/**
 * The sections whose value is a record of named instances kept in one file.
 * They are addressable per instance like a directory is, but they share a
 * document — which is why writing one is a read-modify-write that has to happen
 * under the same lock as any other write, rather than in the caller.
 */
type ContributionKey = {
  [K in ConfigKey]: Sections[K]['kind'] extends 'contribution' ? K : never;
}[ConfigKey];

type EntryValue<K extends DirectoryKey> = ConfigMap[K][string];

type InstanceValue<K extends ContributionKey> = ConfigMap[K][string];

function erase(key: ConfigKey): ConfigSection {
  return sections[key] as ConfigSection;
}

/** The section behind a key `DirectoryKey` has already proved is a directory. */
function eraseDirectory(key: DirectoryKey): DirectorySection {
  return sections[key];
}

/** The section behind a key `ContributionKey` has already proved is contributed. */
function eraseContribution(key: ContributionKey): ContributionSection {
  return sections[key];
}

/** The record `key` holds now, without `entryId`. Never mutates the one in place. */
function without(record: Record<string, unknown>, entryId: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== entryId));
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

  /**
   * Writes one entry of a directory section. A directory has no whole-document
   * write — `update` refuses one — because its entries are separate files with
   * separate lifetimes: rewriting the set to change one of them would make
   * every reader of the others a party to that change.
   *
   * `validate` sees the parsed entry before anything is written, for the checks
   * an entry's own schema cannot make because they are about the rest of the
   * configuration. Throwing from it leaves the entry exactly as it was.
   */
  public async updateEntry<K extends DirectoryKey>(
    key: K,
    entryId: string,
    next: unknown,
    validate?: (value: EntryValue<K>) => Promise<void> | void,
  ): Promise<ConfigUpdate<EntryValue<K>>> {
    const section = eraseDirectory(key);

    return this.#updates.run(async () => {
      const value = await updateEntry(section, this.#context, entryId, next, async (parsed) => {
        await validate?.(parsed as EntryValue<K>);
      });

      const current = (this.#values.get(key) ?? {}) as Record<string, unknown>;
      this.#values.set(key, { ...current, [entryId]: value });

      return { restartRequired: section.applies === 'restart', value: value as EntryValue<K> };
    });
  }

  /**
   * Removes one entry. `false` means there was nothing to remove, which is what
   * the caller asked for either way — the distinction is the surface's to
   * report, not this module's to treat as a failure.
   */
  public async removeEntry(key: DirectoryKey, entryId: string): Promise<boolean> {
    const section = eraseDirectory(key);

    return this.#updates.run(async () => {
      if (!(await removeEntry(section, this.#context, entryId))) return false;

      const current = (this.#values.get(key) ?? {}) as Record<string, unknown>;
      this.#values.set(key, without(current, entryId));

      return true;
    });
  }

  /**
   * Writes one instance of a contributed section. Unlike a directory entry this
   * is a read-modify-write of a shared document, so it happens here rather than
   * in a caller: reading the record, replacing one key and writing it back is
   * only safe while nothing else may write between the read and the write, and
   * this is the lock that guarantees it.
   *
   * The whole document is re-validated, which is the point — an instance is
   * validated against the union assembled from what extensions contributed, and
   * one that names a `type` nobody registered is refused with the rest of the
   * file unchanged.
   *
   * `validate` sees the parsed instance before anything is written, exactly as
   * `updateEntry` shows it a parsed entry. The two are the same promise made
   * about the two ways a section stores entries, so a caller can insist on
   * something without first asking which kind of section it is writing to.
   */
  public async updateInstance<K extends ContributionKey>(
    key: K,
    instanceId: string,
    next: unknown,
    validate?: (value: InstanceValue<K>) => Promise<void> | void,
  ): Promise<ConfigUpdate<InstanceValue<K>>> {
    const section = eraseContribution(key);

    return this.#updates.run(async () => {
      const current = this.#requireRecord(key);
      const written = (await updateSection(
        section,
        this.#context,
        { ...current, [instanceId]: next },
        current,
        this.#reader(key),
        async (document) => {
          await validate?.((document as Record<string, unknown>)[instanceId] as InstanceValue<K>);
        },
      )) as Record<string, unknown>;

      this.#values.set(key, written);
      return {
        restartRequired: section.applies === 'restart',
        value: written[instanceId] as InstanceValue<K>,
      };
    });
  }

  /**
   * Removes one instance. `false` means the section never named it — the same
   * answer `removeEntry` gives, and for the same reason: gone is what the caller
   * asked for. Nothing is written in that case, so a section whose other
   * instances no longer validate is not disturbed by a no-op removal.
   */
  public async removeInstance(key: ContributionKey, instanceId: string): Promise<boolean> {
    const section = eraseContribution(key);

    return this.#updates.run(async () => {
      const current = this.#requireRecord(key);
      if (!Object.hasOwn(current, instanceId)) return false;

      const written = await updateSection(
        section,
        this.#context,
        without(current, instanceId),
        current,
        this.#reader(key),
      );

      this.#values.set(key, written);
      return true;
    });
  }

  /**
   * The record a contributed section holds now. A section that has not been
   * resolved has no record to modify, and treating it as empty would write a
   * file containing only the instance being added — silently dropping every
   * instance already configured on disk.
   */
  #requireRecord(key: ContributionKey): Record<string, unknown> {
    if (!this.#values.has(key)) {
      throw new ConfigError(
        'unresolved',
        join(this.#context.configDir, erase(key).name),
        'cannot have an instance written before Config.resolve() has read it.',
      );
    }
    return this.#values.get(key) as Record<string, unknown>;
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

export type {
  ConfigOptions,
  ConfigUpdate,
  ContributionKey,
  DirectoryKey,
  EntryValue,
  InstanceValue,
};
