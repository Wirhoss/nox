import type { ContributionReader } from '@nox/extension-api';

const EXTENSION_STATES = ['active', 'failed', 'incompatible', 'loaded'] as const;
const EXTENSION_ORIGINS = ['builtin', 'installed'] as const;

type ExtensionState = (typeof EXTENSION_STATES)[number];
type ExtensionOrigin = (typeof EXTENSION_ORIGINS)[number];

interface ExtensionCatalogEntry {
  readonly error?: string;
  readonly id: string;
  readonly origin: ExtensionOrigin;
  readonly state: ExtensionState;
  readonly version?: string;
}

interface MutableExtensionRecord {
  error?: string;
  id: string;
  origin: ExtensionOrigin;
  state: ExtensionState;
  version?: string;
}

/** Startup inventory shared by diagnostics and the authenticated extension API. */
class ExtensionCatalog {
  readonly #records = new Map<string, MutableExtensionRecord>();

  public add(
    key: string,
    entry: Omit<ExtensionCatalogEntry, 'state'> & { state?: ExtensionState },
  ): void {
    if (this.#records.has(key)) throw new Error(`Extension candidate "${key}" already exists.`);
    this.#records.set(key, { ...entry, state: entry.state ?? 'loaded' });
  }

  public active(key: string): void {
    this.#update(key, 'active');
  }

  public fail(key: string, error: unknown): void {
    this.#update(key, 'failed', messageFrom(error));
  }

  public incompatible(key: string, error: string): void {
    this.#update(key, 'incompatible', error);
  }

  public list(contributions?: ContributionReader): readonly ExtensionDescription[] {
    return Object.freeze(
      [...this.#records.values()]
        .map((entry) =>
          Object.freeze({
            ...(entry.error === undefined ? {} : { error: entry.error }),
            contributions: contributions?.ownedBy(entry.id) ?? [],
            id: entry.id,
            origin: entry.origin,
            state: entry.state,
            ...(entry.version === undefined ? {} : { version: entry.version }),
          }),
        )
        .sort((left, right) => {
          const byId = left.id.localeCompare(right.id);
          return byId === 0 ? left.origin.localeCompare(right.origin) : byId;
        }),
    );
  }

  #update(key: string, state: ExtensionState, error?: string): void {
    const entry = this.#records.get(key);
    if (entry === undefined) throw new Error(`Unknown extension candidate "${key}".`);
    entry.state = state;
    if (error === undefined) delete entry.error;
    else entry.error = error;
  }
}

interface ExtensionDescription extends ExtensionCatalogEntry {
  readonly contributions: readonly { readonly id: string; readonly point: string }[];
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { EXTENSION_ORIGINS, EXTENSION_STATES, ExtensionCatalog };

export type { ExtensionCatalogEntry, ExtensionDescription, ExtensionOrigin, ExtensionState };
