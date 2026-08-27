import { and, eq } from 'drizzle-orm';

import { extensionState } from '../database/schema';

import type { Database, NoxTransaction } from '../database/database';
import type {
  ExtensionStateEntry,
  ExtensionStateTransaction,
  ExtensionStorage,
} from '@nox/extension-api';

interface ExtensionStorageProvider {
  forExtension(extensionId: string): ExtensionStorage;
}

function assertStateName(value: string, label: string): void {
  if (value.trim().length === 0) throw new TypeError(`${label} cannot be empty.`);
}

function encode(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('Extension state must be serializable as JSON.');
  }
  return JSON.stringify(value);
}

function decode(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function assertSynchronous(value: unknown): void {
  if (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value
  ) {
    throw new TypeError('Extension storage transactions must be synchronous.');
  }
}

class DatabaseStateTransaction implements ExtensionStateTransaction {
  readonly #database: NoxTransaction;
  readonly #extensionId: string;

  constructor(database: NoxTransaction, extensionId: string) {
    this.#database = database;
    this.#extensionId = extensionId;
  }

  public delete(collection: string, key: string): boolean {
    this.#assertKey(collection, key);
    return (
      this.#database
        .delete(extensionState)
        .where(
          and(
            eq(extensionState.extensionId, this.#extensionId),
            eq(extensionState.collection, collection),
            eq(extensionState.key, key),
          ),
        )
        .returning({ key: extensionState.key })
        .get() !== undefined
    );
  }

  public entries<T>(
    collection: string,
    parse: (value: unknown) => T,
  ): readonly ExtensionStateEntry<T>[] {
    assertStateName(collection, 'Extension state collection');
    return this.#database
      .select({ key: extensionState.key, value: extensionState.value })
      .from(extensionState)
      .where(
        and(
          eq(extensionState.extensionId, this.#extensionId),
          eq(extensionState.collection, collection),
        ),
      )
      .orderBy(extensionState.key)
      .all()
      .map((row) => Object.freeze({ key: row.key, value: parse(decode(row.value)) }));
  }

  public get<T>(collection: string, key: string, parse: (value: unknown) => T): T | undefined {
    this.#assertKey(collection, key);
    const row = this.#database
      .select({ value: extensionState.value })
      .from(extensionState)
      .where(
        and(
          eq(extensionState.extensionId, this.#extensionId),
          eq(extensionState.collection, collection),
          eq(extensionState.key, key),
        ),
      )
      .get();
    return row === undefined ? undefined : parse(decode(row.value));
  }

  public set(collection: string, key: string, value: unknown): void {
    this.#assertKey(collection, key);
    this.#database
      .insert(extensionState)
      .values({ collection, extensionId: this.#extensionId, key, value: encode(value) })
      .onConflictDoUpdate({
        set: { value: encode(value) },
        target: [extensionState.extensionId, extensionState.collection, extensionState.key],
      })
      .run();
  }

  #assertKey(collection: string, key: string): void {
    assertStateName(collection, 'Extension state collection');
    assertStateName(key, 'Extension state key');
  }
}

class DatabaseExtensionStorageProvider implements ExtensionStorageProvider {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  public forExtension(extensionId: string): ExtensionStorage {
    assertStateName(extensionId, 'Extension ID');
    return Object.freeze({
      transact: async <T>(run: (transaction: ExtensionStateTransaction) => T): Promise<T> =>
        this.#database.transaction((database) => {
          const result = run(new DatabaseStateTransaction(database, extensionId));
          assertSynchronous(result);
          return result;
        }),
    });
  }
}

class MemoryStateTransaction implements ExtensionStateTransaction {
  readonly #collections: Map<string, Map<string, string>>;

  constructor(collections: Map<string, Map<string, string>>) {
    this.#collections = collections;
  }

  public delete(collection: string, key: string): boolean {
    this.#assertKey(collection, key);
    return this.#collections.get(collection)?.delete(key) ?? false;
  }

  public entries<T>(
    collection: string,
    parse: (value: unknown) => T,
  ): readonly ExtensionStateEntry<T>[] {
    assertStateName(collection, 'Extension state collection');
    return [...(this.#collections.get(collection)?.entries() ?? [])]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => Object.freeze({ key, value: parse(decode(value)) }));
  }

  public get<T>(collection: string, key: string, parse: (value: unknown) => T): T | undefined {
    this.#assertKey(collection, key);
    const value = this.#collections.get(collection)?.get(key);
    return value === undefined ? undefined : parse(decode(value));
  }

  public set(collection: string, key: string, value: unknown): void {
    this.#assertKey(collection, key);
    let entries = this.#collections.get(collection);
    if (entries === undefined) {
      entries = new Map();
      this.#collections.set(collection, entries);
    }
    entries.set(key, encode(value));
  }

  #assertKey(collection: string, key: string): void {
    assertStateName(collection, 'Extension state collection');
    assertStateName(key, 'Extension state key');
  }
}

class MemoryExtensionStorageProvider implements ExtensionStorageProvider {
  readonly #extensions = new Map<string, Map<string, Map<string, string>>>();

  public forExtension(extensionId: string): ExtensionStorage {
    assertStateName(extensionId, 'Extension ID');
    return Object.freeze({
      transact: <T>(run: (transaction: ExtensionStateTransaction) => T): Promise<T> => {
        const current: Map<string, Map<string, string>> = this.#extensions.get(extensionId) ??
        new Map<string, Map<string, string>>();
        const candidate = new Map<string, Map<string, string>>(
          [...current].map(([collection, entries]): [string, Map<string, string>] => [
            collection,
            new Map(entries),
          ]),
        );
        try {
          const result = run(new MemoryStateTransaction(candidate));
          assertSynchronous(result);
          this.#extensions.set(extensionId, candidate);
          return Promise.resolve(result);
        } catch (error) {
          return Promise.reject(
            error instanceof Error
              ? error
              : new Error('Extension state transaction failed.', { cause: error }),
          );
        }
      },
    });
  }
}

export { DatabaseExtensionStorageProvider, MemoryExtensionStorageProvider };

export type { ExtensionStorageProvider };
