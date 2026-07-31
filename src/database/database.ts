import { DataSource } from 'typeorm';

import { createLogger } from '../logger';
import { SerialQueue } from '../utils';

import { getDriver } from './driver';
import {
  ConnectionFailedError,
  MigrationFailedError,
  NotInitializedError,
  UnknownStoreError,
} from './error';
import { migrations as registeredMigrations } from './migrations';
import { entities as registeredEntities } from './schema';
import { stores as registeredStores } from './stores';

import type { DatabaseConfig } from './config';
import type { MigrationClass } from './migrations';
import type { StoreFactory, StoreKey, StoreMap } from './stores';
import type { EntityManager, EntitySchema, EntityTarget, Migration, Repository } from 'typeorm';

const logger = createLogger('database');

interface DatabaseOptions {
  config: DatabaseConfig;
  connection: string;
  entities?: EntitySchema[];
  migrations?: MigrationClass[];
  stores?: Record<string, StoreFactory>;
}

class Database {
  readonly #options: DatabaseOptions;
  readonly #queue = new SerialQueue();
  readonly #storeInstances = new Map<string, unknown>();
  #dataSource?: DataSource;

  constructor(options: DatabaseOptions) {
    this.#options = options;
  }

  public get isInitialized(): boolean {
    return this.#dataSource?.isInitialized ?? false;
  }

  public get dataSource(): DataSource {
    if (!this.#dataSource) {
      throw new NotInitializedError('access the data source');
    }
    return this.#dataSource;
  }

  public async init(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    const { config, connection } = this.#options;
    const driver = getDriver(config.driver);
    const context = {
      connection,
      entities: this.#options.entities ?? registeredEntities,
      migrations: this.#options.migrations ?? registeredMigrations,
    };
    const target = driver.describe(context);
    const startedAt = Date.now();

    const dataSource = new DataSource(driver.options(config, context));
    try {
      await dataSource.initialize();
      await driver.afterConnect?.(dataSource, config);
    } catch (error) {
      await dataSource.destroy().catch(() => undefined);
      logger.error({ driver: driver.name, err: error, target }, 'Database connection failed.');
      throw new ConnectionFailedError(target, error);
    }

    this.#dataSource = dataSource;
    logger.info(
      { driver: driver.name, durationMs: Date.now() - startedAt, target },
      'Database opened.',
    );
  }

  public async migrate(): Promise<Migration[]> {
    const dataSource = this.dataSource;
    const target = getDriver(this.#options.config.driver).describe({
      connection: this.#options.connection,
      entities: [],
      migrations: [],
    });

    return this.#serialize(async () => {
      const startedAt = Date.now();
      try {
        const applied = await dataSource.runMigrations({ transaction: 'all' });
        logger.info(
          { applied: applied.map((migration) => migration.name), durationMs: Date.now() - startedAt },
          'Database migrations applied.',
        );
        return applied;
      } catch (error) {
        logger.error({ err: error, target }, 'Database migration failed.');
        throw new MigrationFailedError(target, error);
      }
    });
  }

  public repository<T extends object>(target: EntityTarget<T>): Repository<T> {
    return this.dataSource.getRepository(target);
  }

  public async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    const dataSource = this.dataSource;
    return this.#serialize(() => dataSource.transaction(work));
  }

  public async write<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    const dataSource = this.dataSource;
    return this.#serialize(() => work(dataSource.manager));
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    return getDriver(this.#options.config.driver).serializeWrites
      ? this.#queue.run(work)
      : work();
  }

  public store<K extends StoreKey>(name: K): StoreMap[K] {
    const registry: Record<string, StoreFactory> = this.#options.stores ?? registeredStores;
    const cached = this.#storeInstances.get(name as string);
    if (cached !== undefined) {
      return cached as StoreMap[K];
    }

    const factory = registry[name as string];
    if (!factory) {
      throw new UnknownStoreError(name as string, Object.keys(registry));
    }

    if (!this.isInitialized) {
      throw new NotInitializedError(`build store "${String(name)}"`);
    }

    const instance = factory(this);
    this.#storeInstances.set(name as string, instance);
    return instance as StoreMap[K];
  }

  public async health(): Promise<boolean> {
    if (!this.isInitialized) {
      return false;
    }
    try {
      await this.dataSource.query('SELECT 1');
      return true;
    } catch (error) {
      logger.warn({ err: error }, 'Database health check failed.');
      return false;
    }
  }

  public async close(): Promise<void> {
    if (!this.#dataSource) {
      return;
    }

    const dataSource = this.#dataSource;
    this.#dataSource = undefined;
    this.#storeInstances.clear();

    await this.#queue.drain();
    await dataSource.destroy();
    logger.info('Database closed.');
  }
}

export {
  Database,
};

export type {
  DatabaseOptions,
};
