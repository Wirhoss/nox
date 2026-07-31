import type { DatabaseConfig, DatabaseDriverName } from '../config';
import type { DataSource, DataSourceOptions, EntitySchema, MixedList } from 'typeorm';

interface DriverContext {
  connection: string;
  entities: MixedList<EntitySchema>;
  migrations: DataSourceOptions['migrations'];
}

interface DatabaseDriver {
  readonly name: DatabaseDriverName;
  readonly serializeWrites: boolean;
  afterConnect?(dataSource: DataSource, config: DatabaseConfig): Promise<void>;
  describe(context: DriverContext): string;
  options(config: DatabaseConfig, context: DriverContext): DataSourceOptions;
}

export type {
  DatabaseDriver,
  DriverContext,
};
