import { BunSqliteDriver } from './bunSqlite';

import type { DatabaseConfig } from '../../config';
import type { DatabaseDriver, DriverContext } from '../driver';
import type { DataSource, DataSourceOptions } from 'typeorm';

const sqliteDriver: DatabaseDriver = {
  name: 'sqlite',
  serializeWrites: true,
  async afterConnect(dataSource: DataSource, config: DatabaseConfig): Promise<void> {
    if (!config.sqlite.foreignKeys) {
      await dataSource.query('PRAGMA foreign_keys = OFF');
    }
  },

  describe(context: DriverContext): string {
    return context.connection;
  },

  options(config: DatabaseConfig, context: DriverContext): DataSourceOptions {
    const { busyTimeoutMs, enableWAL, statementCacheSize } = config.sqlite;

    return {
      database: context.connection,
      driver: BunSqliteDriver,
      enableWAL,
      entities: context.entities,
      migrations: context.migrations,
      migrationsRun: false,
      statementCacheSize,
      synchronize: false,
      timeout: busyTimeoutMs,
      type: 'better-sqlite3',
    };
  },
};

export {
  sqliteDriver,
};
