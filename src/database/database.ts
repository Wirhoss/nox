import { mkdirSync } from 'node:fs';

import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

type NoxDatabase = SQLiteBunDatabase & { $client: Database };

function openDatabase(databaseFile: string): NoxDatabase {
  if (databaseFile !== ':memory:' && databaseFile.includes('/')) {
    mkdirSync(databaseFile.substring(0, databaseFile.lastIndexOf('/')), { recursive: true });
  }
  const sqlite = new Database(databaseFile, { create: true });
  sqlite.run('PRAGMA journal_mode = WAL;');
  sqlite.run('PRAGMA foreign_keys = ON;');
  const database = drizzle({ client: sqlite });
  migrate(database, { migrationsFolder: `${import.meta.dir}/migrations` });
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
