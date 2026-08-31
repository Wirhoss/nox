import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Database as SqliteConnection } from 'bun:sqlite';
import { load as loadVectorSupport } from 'sqlite-vec';

import { silentLogger } from '../logger/logger';
import { Mutex } from '../utils/mutex';

import type { Logger } from '../logger/logger';
import type {
  ExtensionStateEntry,
  ExtensionStateTransaction,
  ExtensionStorage,
  SqlValue,
} from '@nox/extension-api';

/**
 * Tables the host owns inside the database shared by extensions.
 *
 * Collection rows and migration names carry the extension id because those are
 * host-managed namespaces. SQL tables are deliberately not rewritten: doing so
 * without a SQLite parser would make the apparent boundary depend on string
 * inspection. Extensions therefore use globally unique table names, while the
 * `nox_` prefix remains reserved for this host metadata.
 */
const STATE_TABLE = 'nox_state';
const MIGRATIONS_TABLE = 'nox_migrations';

const HOST_DDL = [
  `CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (` +
    'extension_id TEXT NOT NULL, ' +
    'collection TEXT NOT NULL, ' +
    'key TEXT NOT NULL, ' +
    'value TEXT NOT NULL, ' +
    'PRIMARY KEY (extension_id, collection, key)' +
    ')',
  `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (` +
    'extension_id TEXT NOT NULL, ' +
    'name TEXT NOT NULL, ' +
    'applied_at TEXT NOT NULL, ' +
    'PRIMARY KEY (extension_id, name)' +
    ')',
];

interface ExtensionDatabaseOptions {
  readonly logger?: Logger;
  readonly path: string;
}

interface ExtensionRegistration {
  readonly extensionId: string;
  /** Absolute directory of `.sql` files the extension ships, applied in name order. */
  readonly migrations?: string;
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

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The extension-scoped collection methods and the shared SQL connection. */
class ExtensionTransaction implements ExtensionStateTransaction {
  readonly #connection: SqliteConnection;
  readonly #extensionId: string;

  constructor(connection: SqliteConnection, extensionId: string) {
    this.#connection = connection;
    this.#extensionId = extensionId;
  }

  public all<T>(
    sql: string,
    parameters: readonly SqlValue[],
    parse: (row: unknown) => T,
  ): readonly T[] {
    return this.#connection
      .query<Record<string, unknown>, SqlValue[]>(sql)
      .all(...parameters)
      .map((row) => parse(row));
  }

  public delete(collection: string, key: string): boolean {
    this.#assertKey(collection, key);
    return (
      this.#connection.run(
        `DELETE FROM ${STATE_TABLE} WHERE extension_id = ? AND collection = ? AND key = ?`,
        [this.#extensionId, collection, key],
      ).changes > 0
    );
  }

  public entries<T>(
    collection: string,
    parse: (value: unknown) => T,
  ): readonly ExtensionStateEntry<T>[] {
    assertStateName(collection, 'Extension state collection');
    return this.#connection
      .query<{ key: string; value: string }, [string, string]>(
        `SELECT key, value FROM ${STATE_TABLE} WHERE extension_id = ? AND collection = ? ORDER BY key`,
      )
      .all(this.#extensionId, collection)
      .map((row) => Object.freeze({ key: row.key, value: parse(decode(row.value)) }));
  }

  public get<T>(collection: string, key: string, parse: (value: unknown) => T): T | undefined {
    this.#assertKey(collection, key);
    const row = this.#connection
      .query<{ value: string }, [string, string, string]>(
        `SELECT value FROM ${STATE_TABLE} WHERE extension_id = ? AND collection = ? AND key = ?`,
      )
      .get(this.#extensionId, collection, key);
    return row === null ? undefined : parse(decode(row.value));
  }

  public one<T>(
    sql: string,
    parameters: readonly SqlValue[],
    parse: (row: unknown) => T,
  ): T | undefined {
    const row = this.#connection.query<Record<string, unknown>, SqlValue[]>(sql).get(...parameters);
    return row === null ? undefined : parse(row);
  }

  public run(sql: string, parameters: readonly SqlValue[] = []): number {
    return this.#connection.run(sql, [...parameters]).changes;
  }

  public set(collection: string, key: string, value: unknown): void {
    this.#assertKey(collection, key);
    this.#connection.run(
      `INSERT INTO ${STATE_TABLE} (extension_id, collection, key, value) VALUES (?, ?, ?, ?) ` +
        'ON CONFLICT (extension_id, collection, key) DO UPDATE SET value = excluded.value',
      [this.#extensionId, collection, key, encode(value)],
    );
  }

  #assertKey(collection: string, key: string): void {
    assertStateName(collection, 'Extension state collection');
    assertStateName(key, 'Extension state key');
  }
}

/** A stable extension-scoped view over the process-wide extension database. */
class ExtensionStorageView implements ExtensionStorage {
  readonly #database: ExtensionDatabase;
  readonly #extensionId: string;

  constructor(database: ExtensionDatabase, extensionId: string) {
    this.#database = database;
    this.#extensionId = extensionId;
  }

  public transact<T>(run: (transaction: ExtensionStateTransaction) => T): Promise<T> {
    return this.#database.transact(this.#extensionId, run);
  }
}

/**
 * The one SQLite database and connection shared by every extension.
 *
 * Keeping it separate from `nox.db` is the security boundary that matters: SQL
 * supplied by an extension can reach other extension-owned SQL tables, but can
 * never reach accounts, secrets, sessions or messages. One write mutex also
 * gives every extension transaction the same ordering guarantees as the kernel
 * database without opening a connection per installed package.
 */
class ExtensionDatabase {
  readonly #connection: SqliteConnection;
  readonly #logger: Logger;
  readonly #path: string;
  readonly #writes = new Mutex();

  #closed = false;

  private constructor(options: ExtensionDatabaseOptions, logger: Logger) {
    this.#logger = logger;
    this.#path = options.path;
    this.#connection = new SqliteConnection(options.path, { create: true, readwrite: true });
  }

  public static async open(options: ExtensionDatabaseOptions): Promise<ExtensionDatabase> {
    const database = new ExtensionDatabase(options, options.logger ?? silentLogger);
    try {
      await database.#initialise();
    } catch (error) {
      database.#connection.close(false);
      throw error;
    }
    return database;
  }

  public get isOpen(): boolean {
    return !this.#closed;
  }

  public get path(): string {
    return this.#path;
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    await this.#writes.run(() => {
      if (this.#closed) return;
      this.#closed = true;
      this.#connection.close(false);
    });
  }

  public async forExtension(registration: ExtensionRegistration): Promise<ExtensionStorage> {
    assertStateName(registration.extensionId, 'Extension ID');
    await this.#writes.run(() => {
      this.#assertOpen();
      if (registration.migrations !== undefined) {
        this.#migrate(registration.extensionId, registration.migrations);
      }
    });
    return new ExtensionStorageView(this, registration.extensionId);
  }

  public transact<T>(
    extensionId: string,
    run: (transaction: ExtensionStateTransaction) => T,
  ): Promise<T> {
    return this.#writes.run(() => {
      this.#assertOpen();
      const inTransaction = this.#connection.transaction(() => {
        const result = run(new ExtensionTransaction(this.#connection, extensionId));
        assertSynchronous(result);
        return result;
      });
      return inTransaction();
    });
  }

  /**
   * Vector search is loaded once on the connection every extension shares.
   * `vec0` is exact brute-force KNN, not an approximate index — what it returns
   * is what cosine over the same float32 returns, and what it buys is the
   * arithmetic in C instead of JavaScript, four to five times faster.
   */
  #loadVectorSupport(): void {
    try {
      loadVectorSupport(this.#connection);
    } catch (error) {
      throw new Error(
        `Vector support did not load for the extension database: ${messageFrom(error)}. ` +
          'This installation is missing the sqlite-vec binary for its platform.',
        { cause: error },
      );
    }
  }

  #applyPragmas(): void {
    this.#connection.run('PRAGMA journal_mode = WAL');
    this.#connection.run('PRAGMA busy_timeout = 5000');
    this.#connection.run('PRAGMA synchronous = NORMAL');
    this.#connection.run('PRAGMA foreign_keys = ON');
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`Extension database at ${this.#path} is closed.`);
  }

  async #initialise(): Promise<void> {
    await this.#writes.run(() => {
      this.#applyPragmas();
      // Before migrations, so one of them may create a `vec0` table.
      this.#loadVectorSupport();
      for (const statement of HOST_DDL) this.#connection.run(statement);
    });
  }

  /**
   * Applies one extension's migrations in name order, each in its own
   * transaction and recorded under that extension's id. The same filename in
   * another package is therefore another migration rather than a collision.
   */
  #migrate(extensionId: string, directory: string): void {
    const applied = new Set(
      this.#connection
        .query<{ name: string }, [string]>(
          `SELECT name FROM ${MIGRATIONS_TABLE} WHERE extension_id = ?`,
        )
        .all(extensionId)
        .map((row) => row.name),
    );
    const pending = readdirSync(directory)
      .filter((name) => name.endsWith('.sql'))
      .sort((left, right) => left.localeCompare(right))
      .filter((name) => !applied.has(name));

    for (const name of pending) {
      const sql = readFileSync(join(directory, name), 'utf8');
      const apply = this.#connection.transaction(() => {
        this.#connection.run(sql);
        this.#connection.run(
          `INSERT INTO ${MIGRATIONS_TABLE} (extension_id, name, applied_at) VALUES (?, ?, ?)`,
          [extensionId, name, new Date().toISOString()],
        );
      });
      try {
        apply();
      } catch (error) {
        throw new Error(
          `Extension "${extensionId}" migration "${name}" failed: ${messageFrom(error)}`,
          { cause: error },
        );
      }
    }

    if (pending.length > 0) {
      this.#logger.info(
        { applied: pending.length, extensionId, path: this.#path },
        'Applied pending extension migrations.',
      );
    }
  }
}

export { ExtensionDatabase, MIGRATIONS_TABLE, STATE_TABLE };

export type { ExtensionDatabaseOptions, ExtensionRegistration };
