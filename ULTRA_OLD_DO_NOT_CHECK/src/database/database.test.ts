import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { afterAll, describe, expect, test } from 'bun:test';
import { EntitySchema } from 'typeorm';

import { databaseConfigSchema } from './config';
import { Database } from './database';
import { getDriver } from './driver';
import { isDatabaseError } from './error';

import type { DatabaseConfig } from './config';
import type { MigrationClass } from './migrations';
import type { StoreFactory } from './stores';
import type { MigrationInterface, QueryRunner } from 'typeorm';

interface Widget {
  id: string;
  n: number;
}

const widgetEntity = new EntitySchema<Widget>({
  columns: {
    id: { primary: true, type: String },
    n: { type: Number },
  },
  name: 'widget',
  tableName: 'widget',
});

class CreateWidget1753900000000 implements MigrationInterface {
  public name = 'CreateWidget1753900000000';

  public async up(runner: QueryRunner): Promise<void> {
    await runner.query('CREATE TABLE widget (id varchar PRIMARY KEY, n integer NOT NULL)');
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE widget');
  }
}

class BrokenMigration1753900000001 implements MigrationInterface {
  public name = 'BrokenMigration1753900000001';

  public async up(runner: QueryRunner): Promise<void> {
    await runner.query('THIS IS NOT SQL');
  }

  public async down(): Promise<void> {
    // nothing to undo; the migration never applied.
  }
}

const dirs: string[] = [];
const open: Database[] = [];

function config(overrides: Partial<DatabaseConfig['sqlite']> = {}): DatabaseConfig {
  return databaseConfigSchema.parse({ sqlite: overrides });
}

async function tempFile(name = 'nox.db'): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/nox-database-`);
  dirs.push(dir);
  return `${dir}/${name}`;
}

async function makeDatabase(options: {
  connection?: string;
  migrations?: MigrationClass[];
  sqlite?: Partial<DatabaseConfig['sqlite']>;
  stores?: Record<string, StoreFactory>;
} = {}): Promise<Database> {
  const database = new Database({
    config: config(options.sqlite),
    connection: options.connection ?? ':memory:',
    entities: [widgetEntity],
    migrations: options.migrations ?? [CreateWidget1753900000000],
    stores: options.stores ?? {},
  });
  open.push(database);
  await database.init();
  return database;
}

/** DataSource.query is untyped; keep the cast in one place. */
async function pragma(database: Database, name: string): Promise<Record<string, unknown>[]> {
  return database.dataSource.query(`PRAGMA ${name}`) as Promise<Record<string, unknown>[]>;
}

async function migrated(options: Parameters<typeof makeDatabase>[0] = {}): Promise<Database> {
  const database = await makeDatabase(options);
  await database.migrate();
  return database;
}

afterAll(async () => {
  await Promise.all(open.map((database) => database.close()));
  await Promise.all(dirs.map((dir) => rm(dir, { force: true, recursive: true })));
});

describe('Database lifecycle', () => {
  test('init opens the connection', async () => {
    const database = await makeDatabase();
    expect(database.isInitialized).toBe(true);
    expect(await database.health()).toBe(true);
  });

  test('init is idempotent and keeps the same connection', async () => {
    const database = await makeDatabase();
    const first = database.dataSource;

    await database.init();

    expect(database.isInitialized).toBe(true);
    expect(database.dataSource).toBe(first);
  });

  test('using the data source before init throws not_initialized', () => {
    const database = new Database({
      config: config(),
      connection: ':memory:',
      entities: [],
      migrations: [],
      stores: {},
    });

    expect(() => database.dataSource).toThrow(/not initialized/i);
    try {
      expect(database.dataSource).toBeUndefined();
    } catch (error) {
      expect(isDatabaseError(error) && error.code).toBe('not_initialized');
    }
  });

  test('a connection failure surfaces as connection_failed and leaves it closed', async () => {
    const dir = await mkdtemp(`${tmpdir()}/nox-database-`);
    dirs.push(dir);

    // Pointing sqlite at a directory cannot succeed.
    const database = new Database({
      config: config(),
      connection: dir,
      entities: [],
      migrations: [],
      stores: {},
    });

    try {
      await database.init();
      throw new Error('expected init to fail');
    } catch (error) {
      expect(isDatabaseError(error) && error.code).toBe('connection_failed');
    }

    expect(database.isInitialized).toBe(false);
    expect(await database.health()).toBe(false);
  });

  test('close is idempotent and health reports false afterwards', async () => {
    const database = await makeDatabase();

    await database.close();
    expect(database.isInitialized).toBe(false);
    expect(await database.health()).toBe(false);

    await database.close();
    expect(database.isInitialized).toBe(false);
  });

  test('close waits for a pending write to finish', async () => {
    const database = await migrated();
    let finished = false;

    const pending = database.write(async (manager) => {
      await Bun.sleep(15);
      await manager.getRepository<Widget>('widget').insert({ id: 'late', n: 1 });
      finished = true;
    });

    await database.close();
    expect(finished).toBe(true);
    await pending;
  });
});

describe('Database migrations', () => {
  test('migrate applies pending migrations and is a no-op once applied', async () => {
    const database = await makeDatabase();

    const applied = await database.migrate();
    expect(applied.map((migration) => migration.name)).toEqual(['CreateWidget1753900000000']);

    expect(await database.migrate()).toEqual([]);
    expect(await database.dataSource.showMigrations()).toBe(false);
  });

  test('a failing migration surfaces as migration_failed', async () => {
    const database = await makeDatabase({
      migrations: [CreateWidget1753900000000, BrokenMigration1753900000001],
    });

    try {
      await database.migrate();
      throw new Error('expected migrate to fail');
    } catch (error) {
      expect(isDatabaseError(error) && error.code).toBe('migration_failed');
    }
  });

  test('migrate before init throws not_initialized', async () => {
    const database = new Database({
      config: config(),
      connection: ':memory:',
      entities: [],
      migrations: [],
      stores: {},
    });

    await expect(database.migrate()).rejects.toThrow(/not initialized/i);
  });
});

describe('Database writes', () => {
  test('transaction commits', async () => {
    const database = await migrated();

    await database.transaction(async (manager) => {
      await manager.getRepository<Widget>('widget').insert({ id: 'a', n: 1 });
    });

    expect(await database.repository<Widget>('widget').findOneBy({ id: 'a' }))
      .toEqual({ id: 'a', n: 1 });
  });

  test('transaction rolls back on throw', async () => {
    const database = await migrated();

    await expect(database.transaction(async (manager) => {
      await manager.getRepository<Widget>('widget').insert({ id: 'rollback', n: 1 });
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(await database.repository<Widget>('widget').findOneBy({ id: 'rollback' })).toBeNull();
  });

  test('overlapping transactions are serialized rather than interleaved', async () => {
    const database = await migrated();
    const order: string[] = [];

    const unit = (name: string, delay: number) => async (): Promise<void> => {
      await database.transaction(async (manager) => {
        order.push(`${name}:start`);
        await Bun.sleep(delay);
        await manager.getRepository<Widget>('widget').insert({ id: name, n: 1 });
        order.push(`${name}:end`);
      });
    };

    await Promise.all([unit('first', 15)(), unit('second', 0)()]);

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(await database.repository<Widget>('widget').count()).toBe(2);
  });

  test('sqlite declares that it needs write serialization', () => {
    // If a pooled driver is added it sets this false and skips the queue; this
    // asserts the sqlite side of that switch stays on.
    expect(getDriver('sqlite').serializeWrites).toBe(true);
  });

  test('the same overlap fails without the queue, which is why it exists', async () => {
    const database = await migrated();

    // Straight at the DataSource, bypassing Database.transaction(): sqlite has
    // no nested transactions, so the second one collides with the first.
    const raw = (name: string, delay: number): Promise<void> =>
      database.dataSource.transaction(async (manager) => {
        await Bun.sleep(delay);
        await manager.getRepository<Widget>('widget').insert({ id: name, n: 1 });
      });

    await expect(Promise.all([raw('x', 15), raw('y', 0)])).rejects.toThrow();
  });

  test('write serializes without wrapping work in a transaction', async () => {
    const database = await migrated();

    await database.write(async (manager) => {
      await manager.getRepository<Widget>('widget').insert({ id: 'w', n: 7 });
    });

    expect(await database.repository<Widget>('widget').findOneBy({ id: 'w' }))
      .toEqual({ id: 'w', n: 7 });
  });

  test('a failed write does not stall later writes', async () => {
    const database = await migrated();

    await expect(database.write(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await database.write(async (manager) => {
      await manager.getRepository<Widget>('widget').insert({ id: 'after', n: 1 });
    });

    expect(await database.repository<Widget>('widget').findOneBy({ id: 'after' })).not.toBeNull();
  });
});

describe('Database stores', () => {
  test('store instantiates lazily and caches the instance', async () => {
    let built = 0;
    const database = await makeDatabase({
      stores: { widgets: (owner): { owner: Database } => { built += 1; return { owner }; } },
    });

    expect(built).toBe(0);

    const first = database.store('widgets' as never);
    expect(built).toBe(1);
    expect(database.store('widgets' as never)).toBe(first);
    expect(built).toBe(1);
    expect((first as { owner: Database }).owner).toBe(database);
  });

  test('an unregistered store throws unknown_store and lists what exists', async () => {
    const database = await makeDatabase({ stores: { widgets: () => ({}) } });

    try {
      database.store('missing' as never);
      throw new Error('expected store to fail');
    } catch (error) {
      expect(isDatabaseError(error) && error.code).toBe('unknown_store');
      expect((error as Error).message).toContain('widgets');
    }
  });

  test('building a store before init throws not_initialized', () => {
    const database = new Database({
      config: config(),
      connection: ':memory:',
      entities: [],
      migrations: [],
      stores: { widgets: (): object => ({}) },
    });

    try {
      database.store('widgets' as never);
      throw new Error('expected store to fail');
    } catch (error) {
      expect(isDatabaseError(error) && error.code).toBe('not_initialized');
    }
  });

  test('close drops cached stores so they rebuild against a new connection', async () => {
    let built = 0;
    const database = await makeDatabase({
      stores: { widgets: (): { built: number } => { built += 1; return { built }; } },
    });

    database.store('widgets' as never);
    await database.close();
    await database.init();
    database.store('widgets' as never);

    expect(built).toBe(2);
  });
});

describe('Database configuration', () => {
  test('sqlite options reach the connection', async () => {
    const database = await makeDatabase({
      connection: await tempFile(),
      sqlite: { busyTimeoutMs: 7_777 },
    });

    expect(await pragma(database, 'journal_mode')).toEqual([{ journal_mode: 'wal' }]);
    expect(await pragma(database, 'busy_timeout')).toEqual([{ timeout: 7_777 }]);
    expect(await pragma(database, 'foreign_keys')).toEqual([{ foreign_keys: 1 }]);
  });

  test('foreignKeys: false is honoured despite TypeORM forcing it on', async () => {
    const database = await makeDatabase({
      connection: await tempFile(),
      sqlite: { foreignKeys: false },
    });

    expect(await pragma(database, 'foreign_keys')).toEqual([{ foreign_keys: 0 }]);
  });

  test('enableWAL: false leaves the default journal mode', async () => {
    const database = await makeDatabase({
      connection: await tempFile(),
      sqlite: { enableWAL: false },
    });

    expect(await pragma(database, 'journal_mode')).toEqual([{ journal_mode: 'delete' }]);
  });

  test('defaults materialize from the schema when the section is absent', () => {
    expect(databaseConfigSchema.parse(undefined)).toEqual({
      driver: 'sqlite',
      sqlite: {
        busyTimeoutMs: 5_000,
        enableWAL: true,
        foreignKeys: true,
        statementCacheSize: 100,
      },
    });
  });
});
