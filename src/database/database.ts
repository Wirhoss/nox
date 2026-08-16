import { join } from "node:path";

import { Database as SqliteConnection } from "bun:sqlite";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { type Logger, silentLogger } from "../logger/logger";
import { parseOrThrow } from "../utils/validate";
import { type DatabaseConfig, type DatabaseConfigInput, databaseConfigSchema } from "./config";
import { Mutex } from "./mutex";
import { schema } from "./schema";

// Resolved against this module, not the CWD, so migrations are found wherever
// the process is started from.
const MIGRATIONS_FOLDER = join(import.meta.dir, "migrations");

type NoxDrizzle = BunSQLiteDatabase<typeof schema>;

type NoxTransaction = Parameters<Parameters<NoxDrizzle["transaction"]>[0]>[0];

interface DatabaseOptions extends DatabaseConfigInput {
  logger?: Logger;
}

class Database {
  static #shared?: Promise<Database>;

  readonly #config: DatabaseConfig;
  readonly #connection: SqliteConnection;
  readonly #drizzle: NoxDrizzle;
  readonly #logger: Logger;
  readonly #writes = new Mutex();

  #closed = false;

  private constructor(config: DatabaseConfig, logger: Logger) {
    this.#config = config;
    this.#logger = logger;
    this.#connection = new SqliteConnection(config.path, { create: true, readwrite: true });
    this.#drizzle = drizzle({ client: this.#connection, schema });
  }

  public static current(): Promise<Database> {
    if (Database.#shared === undefined) {
      throw new Error("Database has not been opened. Call Database.open() first.");
    }
    return Database.#shared;
  }

  public static async open(options: DatabaseOptions = {}): Promise<Database> {
    Database.#shared ??= Database.#create(options).catch((error: unknown) => {
      Database.#shared = undefined;
      throw error;
    });
    return Database.#shared;
  }

  static async #create(options: DatabaseOptions): Promise<Database> {
    const config = parseOrThrow(databaseConfigSchema, {
      busyTimeoutMs: options.busyTimeoutMs,
      path: options.path,
      synchronous: options.synchronous,
    });

    const database = new Database(config, options.logger ?? silentLogger);
    await database.#initialise();
    return database;
  }

  public get isOpen(): boolean {
    return !this.#closed;
  }

  public get path(): string {
    return this.#config.path;
  }

  public get db(): NoxDrizzle {
    this.#assertOpen();
    return this.#drizzle;
  }

  public async close(): Promise<void> {
    if (this.#closed) return;

    await this.#writes.run(() => {
      if (this.#closed) return;
      this.#closed = true;
      this.#connection.close(false);
      this.#logger.info({ path: this.#config.path }, "Database closed.");
    });

    Database.#shared = undefined;
  }

  public async exclusive<T>(run: (db: NoxDrizzle) => Promise<T> | T): Promise<T> {
    return this.#writes.run(async () => {
      this.#assertOpen();
      return run(this.#drizzle);
    });
  }

  public async transaction<T>(run: (tx: NoxTransaction) => T): Promise<T> {
    return this.#writes.run(() => {
      this.#assertOpen();
      return this.#drizzle.transaction(run);
    });
  }

  #applyPragmas(): void {
    const journal = this.#connection
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL")
      .get();

    this.#connection.run(`PRAGMA busy_timeout = ${String(this.#config.busyTimeoutMs)}`);
    this.#connection.run(`PRAGMA synchronous = ${this.#config.synchronous.toUpperCase()}`);
    this.#connection.run("PRAGMA foreign_keys = ON");

    if (journal !== null && journal.journal_mode.toLowerCase() !== "wal") {
      this.#logger.warn(
        { journalMode: journal.journal_mode, path: this.#config.path },
        "SQLite refused WAL mode; concurrent readers will block on writers.",
      );
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error(`Database at ${this.#config.path} is closed.`);
    }
  }

  // Drizzle records applied migrations in __drizzle_migrations and wraps the
  // batch in a transaction, so this is idempotent on every open.
  #migrate(): void {
    const applied = this.#appliedMigrations();
    migrate(this.#drizzle, { migrationsFolder: MIGRATIONS_FOLDER });
    const total = this.#appliedMigrations();

    if (total > applied) {
      this.#logger.info(
        { applied: total - applied, path: this.#config.path, total },
        "Applied pending migrations.",
      );
    }
  }

  #appliedMigrations(): number {
    const row = this.#connection
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM sqlite_master " +
          "WHERE type = 'table' AND name = '__drizzle_migrations'",
      )
      .get();
    if (row === null || row.count === 0) return 0;

    return (
      this.#connection
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM __drizzle_migrations")
        .get()?.count ?? 0
    );
  }

  async #initialise(): Promise<void> {
    // Through the write queue so anything racing open() waits for the schema.
    await this.#writes.run(() => {
      this.#applyPragmas();
      this.#migrate();
      this.#logger.info({ path: this.#config.path }, "Database opened.");
    });
  }
}

export { Database };

export type { DatabaseOptions, NoxDrizzle, NoxTransaction };
