import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { eq } from 'drizzle-orm';

import { extensionState } from '../database/schema';
import { ExtensionDatabase, MIGRATIONS_TABLE, STATE_TABLE } from './database';

import type { Database } from '../database/database';
import type { Logger } from '../logger/logger';
import type { ExtensionStorage } from '@nox/extension-api';

/** Everything the host must know before one extension uses shared storage. */
interface ExtensionStorageRequest {
  readonly extensionId: string;
  /** Absolute directory of the `.sql` files this extension ships, if it ships any. */
  readonly migrations?: string;
}

interface ExtensionStorageProvider {
  close(): Promise<void>;
  forExtension(request: ExtensionStorageRequest): Promise<ExtensionStorage>;
}

interface DatabaseExtensionStorageProviderOptions {
  readonly kernel?: Database;
  readonly logger?: Logger;
  readonly path: string;
}

/** Marks the one-time copy out of the kernel database, so it happens once per extension. */
const IMPORTED_STATE = 'nox:imported-extension-state';

function assertStateName(value: string, label: string): void {
  if (value.trim().length === 0) throw new TypeError(`${label} cannot be empty.`);
}

/**
 * One database connection for every installed extension, opened only when the
 * first package asks for storage and held until Nox stops.
 *
 * The file remains separate from `nox.db`, so extension SQL has no connection
 * through which it could reach kernel data. Collection rows are scoped by the
 * extension id inside this database; custom SQL tables use globally unique
 * names supplied by their owning migrations.
 */
class DatabaseExtensionStorageProvider implements ExtensionStorageProvider {
  readonly #kernel?: Database;
  readonly #logger?: Logger;
  readonly #path: string;
  readonly #storages = new Map<string, Promise<ExtensionStorage>>();

  #closed = false;
  #database?: Promise<ExtensionDatabase>;

  constructor(options: DatabaseExtensionStorageProviderOptions) {
    this.#kernel = options.kernel;
    this.#logger = options.logger;
    this.#path = options.path;
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#storages.clear();
    const database = await this.#database?.catch(() => undefined);
    this.#database = undefined;
    await database?.close();
  }

  public async forExtension(request: ExtensionStorageRequest): Promise<ExtensionStorage> {
    if (this.#closed) throw new Error('Extension storage is closed.');
    assertStateName(request.extensionId, 'Extension ID');
    const existing = this.#storages.get(request.extensionId);
    if (existing !== undefined) return existing;

    const opening = this.#openForExtension(request);
    this.#storages.set(request.extensionId, opening);
    try {
      return await opening;
    } catch (error) {
      if (this.#storages.get(request.extensionId) === opening) {
        this.#storages.delete(request.extensionId);
      }
      throw error;
    }
  }

  async #openForExtension(request: ExtensionStorageRequest): Promise<ExtensionStorage> {
    const database = await this.#open();
    const storage = await database.forExtension(request);
    await this.#importKernelState(request.extensionId, storage);
    return storage;
  }

  #open(): Promise<ExtensionDatabase> {
    mkdirSync(dirname(this.#path), { recursive: true });
    this.#database ??= ExtensionDatabase.open({
      ...(this.#logger === undefined ? {} : { logger: this.#logger }),
      path: this.#path,
    });
    return this.#database;
  }

  /**
   * Copies what an older Nox kept in `extension_state` into the shared extension
   * database. The source remains untouched so a downgrade still finds it, while
   * the extension-scoped marker prevents a later boot from restoring a deletion.
   */
  async #importKernelState(extensionId: string, storage: ExtensionStorage): Promise<void> {
    const kernel = this.#kernel;
    if (kernel === undefined) return;

    const imported = await storage.transact(
      (transaction) =>
        transaction.one(
          `SELECT name FROM ${MIGRATIONS_TABLE} WHERE extension_id = ? AND name = ?`,
          [extensionId, IMPORTED_STATE],
          (row) => row,
        ) !== undefined,
    );
    if (imported) return;

    const rows = await kernel.transaction((transaction) =>
      transaction
        .select({
          collection: extensionState.collection,
          key: extensionState.key,
          value: extensionState.value,
        })
        .from(extensionState)
        .where(eq(extensionState.extensionId, extensionId))
        .all(),
    );

    await storage.transact((transaction) => {
      for (const row of rows) {
        transaction.run(
          `INSERT INTO ${STATE_TABLE} (extension_id, collection, key, value) VALUES (?, ?, ?, ?) ` +
            'ON CONFLICT (extension_id, collection, key) DO NOTHING',
          [extensionId, row.collection, row.key, row.value],
        );
      }
      transaction.run(
        `INSERT INTO ${MIGRATIONS_TABLE} (extension_id, name, applied_at) VALUES (?, ?, ?)`,
        [extensionId, IMPORTED_STATE, new Date().toISOString()],
      );
    });

    if (rows.length > 0) {
      this.#logger?.info(
        { extensionId, rows: rows.length },
        'Copied extension state out of the kernel database.',
      );
    }
  }
}

/**
 * The same shared connection, in memory.
 *
 * A real SQLite database rather than a hand-written imitation means tests that
 * exercise storage still exercise its transaction and extension scoping rules.
 */
class MemoryExtensionStorageProvider implements ExtensionStorageProvider {
  readonly #storages = new Map<string, Promise<ExtensionStorage>>();

  #closed = false;
  #database?: Promise<ExtensionDatabase>;

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#storages.clear();
    const database = await this.#database?.catch(() => undefined);
    this.#database = undefined;
    await database?.close();
  }

  public async forExtension(request: ExtensionStorageRequest): Promise<ExtensionStorage> {
    if (this.#closed) throw new Error('Extension storage is closed.');
    assertStateName(request.extensionId, 'Extension ID');
    const existing = this.#storages.get(request.extensionId);
    if (existing !== undefined) return existing;

    this.#database ??= ExtensionDatabase.open({ path: ':memory:' });
    const opening = this.#database.then((database) => database.forExtension(request));
    this.#storages.set(request.extensionId, opening);
    try {
      return await opening;
    } catch (error) {
      if (this.#storages.get(request.extensionId) === opening) {
        this.#storages.delete(request.extensionId);
      }
      throw error;
    }
  }
}

export { DatabaseExtensionStorageProvider, MemoryExtensionStorageProvider };

export type {
  DatabaseExtensionStorageProviderOptions,
  ExtensionStorageProvider,
  ExtensionStorageRequest,
};
