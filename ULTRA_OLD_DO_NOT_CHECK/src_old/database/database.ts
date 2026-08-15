import { mkdirSync } from 'node:fs';

import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

import { createLogger } from '../logger';

import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

type NoxDatabase = SQLiteBunDatabase & { $client: Database };

const logger = createLogger('database');

function openDatabase(databaseFile: string): NoxDatabase {
  if (databaseFile !== ':memory:' && databaseFile.includes('/')) {
    mkdirSync(databaseFile.substring(0, databaseFile.lastIndexOf('/')), { recursive: true });
  }
  const sqlite = new Database(databaseFile, { create: true });
  sqlite.run('PRAGMA journal_mode = WAL;');
  sqlite.run('PRAGMA foreign_keys = ON;');
  const database = drizzle({ client: sqlite });
  const startedAt = Date.now();
  try {
    migrate(database, { migrationsFolder: `${import.meta.dir}/migrations` });
  } catch (error) {
    // A failed migration leaves the schema in an unknown state; say so loudly
    // before the error unwinds into a generic startup failure.
    logger.error({ databaseFile, err: error }, 'Database migration failed.');
    throw error;
  }
  logger.info({ databaseFile, durationMs: Date.now() - startedAt }, 'Database opened and migrated.');
  return database;
}

function closeDatabase(database: NoxDatabase): void {
  database.$client.close();
}

export {
  closeDatabase,
  openDatabase,
};

export type {
  NoxDatabase,
};
