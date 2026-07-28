import { drizzle, SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

interface DatabaseOptions {
  databasePath: string;
}

class Database {
  private database: SQLiteBunDatabase;

  constructor(options: DatabaseOptions) {
    const { databasePath } = options;
    this.database = drizzle({ connection: { source: databasePath } });
  }
}

export {
  Database
}

export type {
  DatabaseOptions
}