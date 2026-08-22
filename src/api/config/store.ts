import { type ConfigKey, sections } from '../../config/sections';
import { configPolicies, type SectionPolicies, type SectionPolicy } from './policies';

import type { Config, ConfigUpdate, ContributionKey, DirectoryKey } from '../../config/config';
import type { ConfigApply, ConfigSection } from '../../config/section';
import type { BlueprintContext } from './blueprints';

/**
 * The sections addressed one entry at a time. Whether those entries are separate
 * files or keys of one document is the loader's business; from here they are the
 * same thing, and a surface that had to know the difference would be a surface
 * that breaks when a section changes how it is stored.
 */
type EntryKey = ContributionKey | DirectoryKey;

/**
 * A section as an administrable thing rather than as a loader input: what it is
 * called, when a change to it takes effect, whether it can be read yet, and
 * which of the two shapes of write it accepts. A surface builds its whole
 * navigation from this, which is why the flags are stated rather than left for
 * the client to infer from `kind`.
 */
interface SectionSummary {
  readonly applies: ConfigApply;
  /** Whether it is addressed one entry at a time. */
  readonly entries: boolean;
  readonly key: ConfigKey;
  readonly kind: ConfigSection['kind'];
  /** Deferred sections have no value until the extensions behind them activate. */
  readonly loaded: boolean;
  readonly name: string;
  /** Whether the whole document may be replaced in one write. */
  readonly writable: boolean;
}

/** An entry nothing may remove yet, and the reasons an operator can act on. */
class EntryInUseError extends Error {
  public readonly reasons: readonly string[];

  constructor(key: ConfigKey, entryId: string, reasons: readonly string[]) {
    super(`"${entryId}" cannot be removed from ${sections[key].name}: ${reasons.join(' ')}`);
    this.name = 'EntryInUseError';
    this.reasons = Object.freeze([...reasons]);
  }
}

/** A record with its keys in a stable order, so a redraw never reorders a list. */
function sorted(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Configuration as something a surface can administer: enumerate the sections,
 * read one, replace one, and — for the sections holding named entries — add,
 * replace and remove those one at a time.
 *
 * It is a view over `Config` rather than a second home for anything: the files
 * stay the only copy, every write goes through the validation the loader
 * performs, and the same lock serializes it.
 *
 * Every section is administered the same way, blueprints included. What a
 * section additionally insists on is a row in the policy table, applied here
 * without this class knowing which section it belongs to — so there is one door
 * onto the configuration files and no chance of a second one's checks drifting
 * from these.
 */
class ConfigStore {
  readonly #config: Config;
  readonly #policies: SectionPolicies;

  constructor(options: BlueprintContext) {
    this.#config = options.config;
    this.#policies = configPolicies(options);
  }

  /** The agent a new web conversation uses, when the installation names one. */
  public get defaultAgent(): string | undefined {
    return this.#config.get('app').chat.defaultAgent;
  }

  /** Every section Nox has, in a stable order. */
  public sections(): readonly SectionSummary[] {
    return Object.freeze(
      (Object.keys(sections) as ConfigKey[])
        .sort((a, b) => a.localeCompare(b))
        .map((key) => this.summary(key)),
    );
  }

  /** The key a URL segment names, or nothing — the surface's 404, not an error. */
  public resolve(name: string): ConfigKey | undefined {
    return Object.hasOwn(sections, name) ? (name as ConfigKey) : undefined;
  }

  public summary(key: ConfigKey): SectionSummary {
    const section = sections[key] as ConfigSection;
    return Object.freeze({
      applies: section.applies,
      entries: section.kind !== 'file',
      key,
      kind: section.kind,
      loaded: this.#config.loaded.includes(key),
      name: section.name,
      // A directory has no whole-document write: its entries are separate files
      // with separate lifetimes, and rewriting the set to change one of them
      // would make every reader of the others a party to that change.
      writable: section.kind !== 'directory',
    });
  }

  public hasEntries(key: ConfigKey): key is EntryKey {
    return sections[key].kind !== 'file';
  }

  /** Throws `ConfigError('unresolved')` for a section the extensions have not reached yet. */
  public read(key: ConfigKey): unknown {
    const value = this.#config.get(key);
    return this.hasEntries(key) ? sorted(value) : value;
  }

  public async write(key: ConfigKey, next: unknown): Promise<ConfigUpdate<unknown>> {
    return this.#config.update(key, next as never);
  }

  public readEntry(key: EntryKey, entryId: string): unknown {
    return (this.#config.get(key) as Record<string, unknown>)[entryId];
  }

  /**
   * Writes one entry, through whichever mechanism its section stores entries
   * with. Both are serialized by `Config` and both show the section's policy the
   * parsed entry before writing, so an entry refused by a policy leaves no file
   * and no half-applied change behind either way.
   */
  public async writeEntry(
    key: EntryKey,
    entryId: string,
    next: unknown,
  ): Promise<ConfigUpdate<unknown>> {
    const validate = this.#policy(key).validate;
    const judge = async (value: unknown): Promise<void> => {
      await validate?.(entryId, value);
    };

    return sections[key].kind === 'directory'
      ? this.#config.updateEntry(key as DirectoryKey, entryId, next, judge)
      : this.#config.updateInstance(key as ContributionKey, entryId, next, judge);
  }

  /**
   * Removes one entry, unless the section's policy says something still needs
   * it. An agent that is the last one and a provider a blueprint still names are
   * the same event to an operator — a removal that would break the next start —
   * and they are answered the same way.
   */
  public async removeEntry(key: EntryKey, entryId: string): Promise<boolean> {
    const reasons = this.#policy(key).reasonsToKeep?.(entryId) ?? [];
    if (reasons.length > 0) throw new EntryInUseError(key, entryId, reasons);

    return sections[key].kind === 'directory'
      ? this.#config.removeEntry(key as DirectoryKey, entryId)
      : this.#config.removeInstance(key as ContributionKey, entryId);
  }

  /** A section with nothing to insist on has no row, which is not a special case. */
  #policy(key: EntryKey): SectionPolicy {
    return this.#policies[key] ?? {};
  }
}

export { ConfigStore, EntryInUseError };

export type { EntryKey, SectionSummary };
