import type { ContributionReader } from '@nox/extension-api';

const EXTENSION_STATES = ['active', 'failed', 'incompatible', 'loaded'] as const;
const EXTENSION_ORIGINS = ['builtin', 'installed'] as const;

type ExtensionState = (typeof EXTENSION_STATES)[number];
type ExtensionOrigin = (typeof EXTENSION_ORIGINS)[number];

interface ExtensionCatalogEntry {
  readonly error?: string;
  /**
   * The libraries this package takes from the host, as it declared them.
   *
   * Reported for the same reason `services` is, and reported even when the
   * package did not load: a version range this installation cannot satisfy is
   * the most likely reason it did not, and hiding the range leaves the reader
   * with an error and no way to act on it.
   */
  readonly hostPackages?: Readonly<Record<string, string>>;
  readonly id: string;
  readonly origin: ExtensionOrigin;
  /**
   * The host services this package declared, straight from its manifest.
   *
   * Carried into the inventory because a declaration nobody can read is not a
   * disclosure. This is the whole of what the package can ask the host for, and
   * the one place an operator can see it without opening the manifest by hand.
   *
   * It is what the package *asked* for, not what it was granted: a control-plane
   * service named by an installed extension appears here and is still refused.
   * Showing the request is the point — it is the part worth reviewing.
   */
  readonly services?: readonly string[];
  readonly state: ExtensionState;
  readonly version?: string;
}

interface MutableExtensionRecord {
  error?: string;
  hostPackages?: Readonly<Record<string, string>>;
  id: string;
  origin: ExtensionOrigin;
  services?: readonly string[];
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
            ...(entry.hostPackages === undefined
              ? {}
              : { hostPackages: Object.freeze({ ...entry.hostPackages }) }),
            id: entry.id,
            origin: entry.origin,
            ...(entry.services === undefined
              ? {}
              : { services: Object.freeze([...entry.services]) }),
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
