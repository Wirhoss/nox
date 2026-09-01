import {
  brokers,
  contributionInstances,
  declareContribution,
  isConfigurable,
} from '@nox/extension-api';
import { z } from 'zod';

import { sections } from '../../config/sections';
import { configPolicies } from './policies';

import type { Config, ConfigUpdate, ContributionKey, DirectoryKey } from '../../config/config';
import type { ConfigSection } from '../../config/section';
import type { ConfigKey } from '../../config/sections';
import type { ToolSetCatalog } from '../../extensions/toolSetCatalog';
import type { ConfigurationRuntime } from '../../runtime/configurationRuntime';
import type { BlueprintContext } from './blueprints';
import type { SectionPolicies, SectionPolicy } from './policies';
import type {
  BrokerContribution,
  ConfigContributionSummary,
  ConfigEntryKey,
  ConfigRevertTarget,
  ConfigSectionSchemaDescriptor,
  ConfigSectionSummary,
  ConfigTypeSchemaDescriptor,
  ConfigurationAdmin,
  ContributionReader,
  ProviderInventory,
  RuntimeComponentStatus,
  ToolSetInventory,
} from '@nox/extension-api';

/**
 * The sections addressed one entry at a time. Whether those entries are separate
 * files or keys of one document is the loader's business; from here they are the
 * same thing, and a surface that had to know the difference would be a surface
 * that breaks when a section changes how it is stored.
 */
type EntryKey = ConfigEntryKey;
type SectionSummary = ConfigSectionSummary;

/**
 * One kind of tool set an operator may configure, with the shape its entries
 * must take.
 *
 * The shape is the contribution's own schema, converted rather than restated: an
 * editor that carried its own idea of what a kind looks like would be a second
 * definition, and the first entry it saved against the wrong one would be
 * refused by the loader with the operator holding a form that had said it was
 * fine.
 */
interface ConfigStoreOptions extends BlueprintContext {
  readonly runtime?: ConfigurationRuntime;
}

interface RevertChange {
  readonly entryId?: string;
  readonly key: ConfigKey;
  readonly previous: unknown;
}

type ToolSetTypeDescriptor = ConfigTypeSchemaDescriptor;

/** A contributed instance keeps the schema it was created under. */
class ContributionTypeChangeError extends Error {
  constructor(key: ConfigKey, entryId: string, currentType: string, nextType: string) {
    super(
      `"${entryId}" in ${sections[key].name} has immutable contribution type ` +
        `"${currentType}"; it cannot be replaced with "${nextType}".`,
    );
    this.name = 'ContributionTypeChangeError';
  }
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
 * read one, replace one, and — for sections holding named entries — add,
 * replace and remove those one at a time. A view over `Config` rather than a
 * second home for anything: the files stay the only copy, every write goes
 * through the loader's validation, and the same lock serializes it.
 *
 * Every section is administered the same way, blueprints included; what a
 * section additionally insists on is a row in the policy table, applied here
 * without this class knowing which section it belongs to — one door onto the
 * configuration files, and no second set of checks to drift.
 */
class ConfigStore implements ConfigurationAdmin {
  readonly #activeApp: unknown;
  readonly #authorities: BlueprintContext['authorities'];
  readonly #config: Config;
  readonly #contributions: ContributionReader;
  readonly #policies: SectionPolicies;
  readonly #runtime?: ConfigurationRuntime;
  readonly #toolSets: ToolSetCatalog;

  #revert?: RevertChange;

  constructor(options: ConfigStoreOptions) {
    this.#activeApp = options.config.get('app');
    this.#authorities = options.authorities;
    this.#config = options.config;
    this.#contributions = options.contributions;
    this.#policies = configPolicies(options);
    this.#runtime = options.runtime;
    this.#toolSets = options.toolSets;
  }

  public get revertAvailable(): boolean {
    return this.#revert !== undefined;
  }

  public get revertTarget(): ConfigRevertTarget | undefined {
    const change = this.#revert;
    return change === undefined
      ? undefined
      : Object.freeze({
          ...(change.entryId === undefined ? {} : { entryId: change.entryId }),
          key: change.key,
        });
  }

  /** Every section Nox has, in a stable order. */
  public sections(): readonly SectionSummary[] {
    return Object.freeze(
      (Object.keys(sections) as ConfigKey[])
        .sort((a, b) => a.localeCompare(b))
        .map((key) => this.summary(key)),
    );
  }

  /**
   * Every contribution this section can hold, and whether it is configured. A
   * surface that only listed entries would show nothing after an extension is
   * installed, which is a wrong answer rather than an empty one: the
   * contribution is there, it has a schema and a name, and a single-instance
   * one has exactly one entry it could ever be. `configured` is read from the
   * current document rather than remembered, so an unresolved section reports
   * everything as unconfigured instead of failing.
   */
  #contributionSummaries(
    key: ConfigKey,
    section: Extract<ConfigSection, { kind: 'contribution' }>,
  ): readonly ConfigContributionSummary[] {
    const configured = new Set<string>();
    if (this.#config.loaded.includes(key)) {
      const value: unknown = this.#config.get(key as ConfigEntryKey);
      for (const entry of Object.values(value as Record<string, unknown>)) {
        if (typeof entry === 'object' && entry !== null && 'type' in entry) {
          configured.add(String(entry.type));
        }
      }
    }

    return Object.freeze(
      this.#contributions
        .list(section.point)
        .flatMap((contribution) => {
          if (!isConfigurable(contribution.value)) return [];
          return [
            Object.freeze({
              configured: configured.has(contribution.id),
              extensionId: contribution.extensionId,
              instances: contributionInstances(contribution.value),
              type: contribution.id,
            }),
          ];
        })
        .sort((left, right) => left.type.localeCompare(right.type)),
    );
  }

  /** The key a URL segment names, or nothing — the surface's 404, not an error. */
  public resolve(name: string): ConfigKey | undefined {
    return Object.hasOwn(sections, name) ? (name as ConfigKey) : undefined;
  }

  public summary(key: ConfigKey): SectionSummary {
    const section = sections[key] as ConfigSection;
    const error = this.#config.problems.find((problem) => problem.key === key)?.error;
    const contributions =
      section.kind === 'contribution' ? this.#contributionSummaries(key, section) : undefined;
    const presentation = section.presentation;
    return Object.freeze({
      applies: section.applies,
      // A directory always accepts operator-named entries. A contribution section
      // does only when at least one installed contribution explicitly allows many.
      creatable:
        section.kind === 'directory' ||
        contributions?.some((contribution) => contribution.instances === 'many') === true,
      ...(contributions === undefined ? {} : { contributions }),
      description: presentation.description,
      editor: presentation.editor,
      entries: section.kind !== 'file',
      ...(presentation.entrySummary === undefined
        ? {}
        : { entrySummary: presentation.entrySummary }),
      ...(error === undefined ? {} : { error }),
      group: presentation.group,
      ...(presentation.inventory === undefined ? {} : { inventory: presentation.inventory }),
      key,
      kind: section.kind,
      label: presentation.label,
      loaded: this.#config.loaded.includes(key),
      name: section.name,
      plural: presentation.plural,
      references: Object.freeze([...(presentation.references ?? [])]),
      slug: presentation.slug,
      // A directory has no whole-document write: its entries are separate files
      // with separate lifetimes, and rewriting the set to change one of them
      // would make every reader of the others a party to that change.
      writable: section.kind !== 'directory',
    });
  }

  /** Every grantable authority, from the same catalog authorization validates against. */
  public authorities(): readonly {
    readonly description: string;
    readonly id: string;
    readonly ownerExtensionId: string;
  }[] {
    const catalog = this.#authorities();
    return Object.freeze(
      catalog.ids.flatMap((id) => {
        const definition = catalog.get(id);
        return definition === undefined ? [] : [Object.freeze({ ...definition })];
      }),
    );
  }

  public hasEntries(key: ConfigKey): key is EntryKey {
    return sections[key].kind !== 'file';
  }

  /**
   * Every kind of tool set that can be configured, and the schema of each.
   *
   * Read on every call rather than captured: contributions arrive when their
   * extension activates and can be disposed afterwards, so a kind that appeared
   * or left is visible here without a restart of the surface.
   */
  public toolSetTypes(): readonly ToolSetTypeDescriptor[] {
    return this.schema('toolSets').types ?? [];
  }

  /**
   * The exact schema a writer is judged against. Contribution sections expose
   * one schema per registered discriminator because their union only exists at
   * runtime; static sections expose their file or entry schema directly.
   */
  public schema(key: ConfigKey): ConfigSectionSchemaDescriptor {
    const section = sections[key] as ConfigSection;
    const base = { applies: section.applies, key, kind: section.kind } as const;

    if (section.kind === 'contribution') {
      const types = this.#contributions
        .list(section.point)
        .flatMap((contribution) => {
          const configurable = contribution.value;
          if (!isConfigurable(configurable)) return [];
          const declared = declareContribution(configurable);
          return [
            Object.freeze({
              extensionId: contribution.extensionId,
              ...brokerHost(section, configurable),
              instances: declared.instances,
              schema: declared.schema,
              type: contribution.id,
            }),
          ];
        })
        .sort((left, right) => left.type.localeCompare(right.type));
      return Object.freeze({ ...base, types: Object.freeze(types) });
    }

    const source = section.kind === 'directory' ? section.entrySchema : section.schema;
    return Object.freeze({
      ...base,
      schema: z.toJSONSchema(source, { io: 'input', unrepresentable: 'any' }),
    });
  }

  /** Tools exposed by each configured capability, using the runtime factories' own answer. */
  public toolSetInventory(): Promise<readonly ToolSetInventory[]> {
    return this.#toolSets.inventory();
  }

  /**
   * Models served by each configured provider, using the live instances' own
   * answer. The configured document cannot supply this: `modelConfigs` is what
   * an operator has declared so far, and the question an editor is asking is
   * what could be declared — which only the endpoint knows.
   */
  public providerInventory(refresh = false): Promise<readonly ProviderInventory[]> {
    return this.#runtime?.providerInventory(refresh) ?? Promise.resolve([]);
  }

  /** Throws `ConfigError('unresolved')` for a section the extensions have not reached yet. */
  public read(key: ConfigKey): unknown {
    const value = this.#config.get(key);
    return this.hasEntries(key) ? sorted(value) : value;
  }

  public async write(key: ConfigKey, next: unknown): Promise<ConfigUpdate<unknown>> {
    const previous = this.#config.loaded.includes(key) ? this.#config.get(key) : undefined;
    assertContributionTypesUnchanged(key, previous, next);
    const validate = this.#policy(key).validateSection;
    const saved = await this.#config.update(key, next as never, async (value) => {
      await validate?.(value);
    });
    await this.#runtime?.reconcile();
    this.#rememberFailure({ key, previous });
    return {
      ...saved,
      restartRequired:
        key === 'app' ? appRestartRequired(this.#activeApp, saved.value) : saved.restartRequired,
    };
  }

  /** Desired-vs-active state for every independently composed component. */
  public runtimeStatuses(): readonly RuntimeComponentStatus[] {
    const runtime = [...(this.#runtime?.statuses() ?? [])];
    const desiredGeneration = Math.max(2, ...runtime.map((status) => status.desiredGeneration + 1));
    if (appRestartRequired(this.#activeApp, this.#config.get('app'))) {
      runtime.push({
        activeGeneration: desiredGeneration - 1,
        desiredGeneration,
        id: 'app',
        kind: 'application',
        state: 'restartRequired',
      });
    }
    for (const problem of this.#config.problems) {
      const kind = problemKind(problem.key);
      runtime.push({
        ...(this.#config.loaded.includes(problem.key)
          ? { activeGeneration: desiredGeneration - 1 }
          : {}),
        desiredGeneration,
        error: problem.error,
        id: problem.key,
        kind,
        state: this.#config.loaded.includes(problem.key) ? 'failed' : 'unavailable',
      });
    }
    return Object.freeze(
      runtime.sort((left, right) => {
        const byKind = left.kind.localeCompare(right.kind);
        return byKind === 0 ? left.id.localeCompare(right.id) : byKind;
      }),
    );
  }

  public async retryRuntime(): Promise<void> {
    await this.#runtime?.reconcile();
    if (
      !this.runtimeStatuses().some(
        (status) => status.state === 'failed' || status.state === 'unavailable',
      )
    ) {
      this.#revert = undefined;
    }
  }

  /** Re-reads explicitly mounted configuration and reconciles every valid changed section. */
  public async reloadConfiguration(
    keys: readonly ConfigKey[] = Object.keys(sections) as ConfigKey[],
  ): Promise<void> {
    const selected = [...new Set(keys)];
    const previous = new Map<ConfigKey, unknown>();
    for (const key of selected) {
      if (this.#config.loaded.includes(key)) previous.set(key, this.#config.get(key));
    }

    const reloaded = await this.#config.reload(selected);
    await this.#runtime?.reconcile();
    for (const key of reloaded.changed) {
      this.#rememberFailure({ key, previous: previous.get(key) });
    }
    if (
      !this.runtimeStatuses().some(
        (status) => status.state === 'failed' || status.state === 'unavailable',
      )
    ) {
      this.#revert = undefined;
    }
  }

  /** Restores the desired value that preceded the most recent failed activation. */
  public async revertRuntime(expectedKey?: ConfigKey): Promise<void> {
    const change = this.#revert;
    if (change === undefined) return;
    if (expectedKey !== undefined && change.key !== expectedKey) {
      throw new Error(
        `The revert target changed from "${expectedKey}" to "${change.key}" before it could be applied.`,
      );
    }

    if (change.entryId === undefined && sections[change.key].kind === 'directory') {
      const key = change.key as DirectoryKey;
      const current = this.#config.get(key) as Record<string, unknown>;
      const previous = change.previous as Record<string, unknown>;
      for (const entryId of Object.keys(current)) {
        if (!Object.hasOwn(previous, entryId)) await this.#config.removeEntry(key, entryId);
      }
      for (const [entryId, value] of Object.entries(previous)) {
        await this.#config.updateEntry(key, entryId, value);
      }
    } else if (change.entryId === undefined) {
      await this.#config.update(change.key, change.previous as never);
    } else if (sections[change.key].kind === 'directory') {
      const key = change.key as DirectoryKey;
      if (change.previous === undefined) await this.#config.removeEntry(key, change.entryId);
      else await this.#config.updateEntry(key, change.entryId, change.previous);
    } else {
      const key = change.key as ContributionKey;
      if (change.previous === undefined) await this.#config.removeInstance(key, change.entryId);
      else await this.#config.updateInstance(key, change.entryId, change.previous);
    }
    await this.#runtime?.reconcile();
    this.#revert = undefined;
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
    const previous = this.readEntry(key, entryId);
    assertContributionTypeUnchanged(key, entryId, previous, next);

    const validate = this.#policy(key).validate;
    const judge = async (value: unknown): Promise<void> => {
      await validate?.(entryId, value);
    };

    const saved =
      sections[key].kind === 'directory'
        ? await this.#config.updateEntry(key as DirectoryKey, entryId, next, judge)
        : await this.#config.updateInstance(key as ContributionKey, entryId, next, judge);
    await this.#runtime?.reconcile();
    this.#rememberFailure({ entryId, key, previous });
    return saved;
  }

  /**
   * Removes one entry, unless the section's policy says something still needs
   * it. An agent that is the last one and a provider a blueprint still names are
   * the same event to an operator — a removal that would break the next start —
   * and they are answered the same way.
   */
  public async removeEntry(key: EntryKey, entryId: string): Promise<boolean> {
    const previous = this.readEntry(key, entryId);
    const reasons = this.#policy(key).reasonsToKeep?.(entryId) ?? [];
    if (reasons.length > 0) throw new EntryInUseError(key, entryId, reasons);

    const removed =
      sections[key].kind === 'directory'
        ? await this.#config.removeEntry(key as DirectoryKey, entryId)
        : await this.#config.removeInstance(key as ContributionKey, entryId);
    if (removed) {
      await this.#runtime?.reconcile();
      this.#rememberFailure({ entryId, key, previous });
    }
    return removed;
  }

  #rememberFailure(change: RevertChange): void {
    if (change.entryId === undefined && change.previous === undefined) return;
    const kind =
      change.key === 'app' || change.key === 'blueprints'
        ? 'agent'
        : change.key === 'memories'
          ? 'memory'
          : change.key === 'providers'
            ? 'provider'
            : change.key === 'toolSets'
              ? 'toolSet'
              : 'broker';
    const failed = this.runtimeStatuses().some(
      (status) =>
        (status.state === 'failed' || status.state === 'unavailable') &&
        status.kind === kind &&
        (change.entryId === undefined || status.id === change.entryId),
    );
    if (failed) {
      this.#revert = change;
    } else if (this.#revert?.key === change.key && this.#revert.entryId === change.entryId) {
      this.#revert = undefined;
    }
  }

  /** A section with nothing to insist on has no row, which is not a special case. */
  #policy(key: ConfigKey): SectionPolicy {
    return this.#policies[key] ?? {};
  }
}

function brokerHost(
  section: Extract<ConfigSection, { kind: 'contribution' }>,
  configurable: object,
): { readonly host?: BrokerContribution['host'] } {
  if (section.point !== brokers) return {};
  const host = (configurable as BrokerContribution).host;
  return host === undefined ? {} : { host: Object.freeze({ ...host }) };
}

function problemKind(key: ConfigKey): RuntimeComponentStatus['kind'] {
  if (key === 'app') return 'application';
  if (key === 'brokers') return 'broker';
  if (key === 'memories') return 'memory';
  if (key === 'providers') return 'provider';
  if (key === 'toolSets') return 'toolSet';
  return 'agent';
}

function appRestartRequired(previous: unknown, next: unknown): boolean {
  if (typeof previous !== 'object' || previous === null) return true;
  if (typeof next !== 'object' || next === null) return true;
  const withoutHot = (value: object): Record<string, unknown> => {
    const {
      logLevel: _logLevel,
      timezone: _timezone,
      ui: _ui,
      ...rest
    } = value as Record<string, unknown>;
    return rest;
  };
  return JSON.stringify(withoutHot(previous)) !== JSON.stringify(withoutHot(next));
}

function assertContributionTypesUnchanged(key: ConfigKey, current: unknown, next: unknown): void {
  if (sections[key].kind !== 'contribution' || !isRecord(current) || !isRecord(next)) return;
  for (const [entryId, currentEntry] of Object.entries(current)) {
    if (!Object.hasOwn(next, entryId)) continue;
    assertContributionTypeUnchanged(key, entryId, currentEntry, next[entryId]);
  }
}

function assertContributionTypeUnchanged(
  key: ConfigKey,
  entryId: string,
  current: unknown,
  next: unknown,
): void {
  if (sections[key].kind !== 'contribution') return;
  const currentType = configType(current);
  const nextType = configType(next);
  if (currentType !== undefined && nextType !== undefined && currentType !== nextType) {
    throw new ContributionTypeChangeError(key, entryId, currentType, nextType);
  }
}

function configType(value: unknown): string | undefined {
  if (!isRecord(value) || !('type' in value)) return undefined;
  return typeof value.type === 'string' ? value.type : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { ConfigStore, ContributionTypeChangeError, EntryInUseError };

export type { ConfigStoreOptions, EntryKey, SectionSummary, ToolSetTypeDescriptor };
