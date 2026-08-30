import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { Database } from '../database/database';
import { extensionState } from '../database/schema';
import { DatabaseExtensionStorageProvider, MemoryExtensionStorageProvider } from './storage';

const parseJson = (value: unknown): unknown => value;

function temporary(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function discard(directory: string): void {
  try {
    rmSync(directory, { force: true, recursive: true });
  } catch {
    // Windows may retain a closed SQLite handle briefly; the temp path is disposable.
  }
}

function extensionPath(directory: string): string {
  return join(directory, 'extensions.db');
}

describe('extension storage', () => {
  test('scopes collections while every extension uses one connection', async () => {
    const provider = new MemoryExtensionStorageProvider();
    const first = await provider.forExtension({ extensionId: 'example.first' });
    const second = await provider.forExtension({ extensionId: 'example.second' });

    await first.transact((transaction) => {
      transaction.set('settings', 'theme', { name: 'dark' });
      // A TEMP table belongs to one SQLite connection rather than to the file.
      // Seeing it through the other view proves the provider did not open one
      // connection per extension behind a common path.
      transaction.run('CREATE TEMP TABLE connection_probe (value TEXT NOT NULL)');
      transaction.run('INSERT INTO connection_probe (value) VALUES (?)', ['shared']);
    });
    expect(
      await first.transact((transaction) => transaction.get('settings', 'theme', parseJson)),
    ).toEqual({ name: 'dark' });
    expect(
      await second.transact((transaction) => transaction.get('settings', 'theme', parseJson)),
    ).toBeUndefined();
    expect(
      await second.transact((transaction) =>
        transaction.all('SELECT value FROM connection_probe', [], (row) => row),
      ),
    ).toEqual([{ value: 'shared' }]);

    expect(
      first.transact((transaction) => {
        transaction.set('settings', 'theme', { name: 'light' });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(
      await first.transact((transaction) => transaction.get('settings', 'theme', parseJson)),
    ).toEqual({ name: 'dark' });

    await provider.close();
  });

  test('persists every extension through one database file', async () => {
    const directory = temporary('nox-extension-state-');
    const path = extensionPath(directory);
    try {
      const provider = new DatabaseExtensionStorageProvider({ path });
      const first = await provider.forExtension({ extensionId: 'example.first' });
      const second = await provider.forExtension({ extensionId: 'example.second' });
      await first.transact((transaction) => {
        transaction.set('documents', 'one', { value: 7 });
      });
      await second.transact((transaction) => {
        transaction.set('documents', 'two', ['a', 'b']);
      });
      await provider.close();

      expect(readdirSync(directory).filter((name) => name.endsWith('.db'))).toEqual([
        'extensions.db',
      ]);

      const reopened = new DatabaseExtensionStorageProvider({ path });
      const firstAgain = await reopened.forExtension({ extensionId: 'example.first' });
      const secondAgain = await reopened.forExtension({ extensionId: 'example.second' });
      expect(
        await firstAgain.transact((transaction) => transaction.entries('documents', parseJson)),
      ).toEqual([{ key: 'one', value: { value: 7 } }]);
      expect(
        await secondAgain.transact((transaction) => transaction.entries('documents', parseJson)),
      ).toEqual([{ key: 'two', value: ['a', 'b'] }]);
      await reopened.close();
    } finally {
      discard(directory);
    }
  });

  test('shares custom SQL tables without exposing the kernel database', async () => {
    const directory = temporary('nox-extension-state-');
    try {
      const provider = new DatabaseExtensionStorageProvider({ path: extensionPath(directory) });
      const owner = await provider.forExtension({ extensionId: 'example.owner' });
      const other = await provider.forExtension({ extensionId: 'example.other' });
      await owner.transact((transaction) => {
        transaction.run('CREATE TABLE example_owner_records (value TEXT NOT NULL)');
        transaction.run('INSERT INTO example_owner_records (value) VALUES (?)', ['kept']);
      });

      // Raw SQL is one database-wide namespace. Prefixing tables avoids package
      // collisions; the separate connection from `nox.db`, rather than pretending
      // to parse extension SQL, is what keeps kernel records unreachable.
      expect(
        await other.transact((transaction) =>
          transaction.all('SELECT value FROM example_owner_records', [], (row) => row),
        ),
      ).toEqual([{ value: 'kept' }]);

      await provider.close();
    } finally {
      discard(directory);
    }
  });

  test('applies each extension migrations once, even when filenames match', async () => {
    const directory = temporary('nox-extension-state-');
    const firstMigrations = temporary('nox-extension-migrations-');
    const secondMigrations = temporary('nox-extension-migrations-');
    const path = extensionPath(directory);
    try {
      writeFileSync(
        join(firstMigrations, '0001_records.sql'),
        'CREATE TABLE example_first_records (text TEXT NOT NULL)',
      );
      writeFileSync(
        join(firstMigrations, '0002_index.sql'),
        'CREATE INDEX example_first_records_text ON example_first_records (text)',
      );
      writeFileSync(
        join(secondMigrations, '0001_records.sql'),
        'CREATE TABLE example_second_records (text TEXT NOT NULL)',
      );

      const provider = new DatabaseExtensionStorageProvider({ path });
      const first = await provider.forExtension({
        extensionId: 'example.first',
        migrations: firstMigrations,
      });
      await provider.forExtension({
        extensionId: 'example.second',
        migrations: secondMigrations,
      });
      await first.transact((transaction) => {
        transaction.run('INSERT INTO example_first_records (text) VALUES (?)', ['remembered']);
      });
      await provider.close();

      // A second boot finds every package migration under its owner and replays
      // none, including the filename both packages legitimately used.
      const reopened = new DatabaseExtensionStorageProvider({ path });
      const again = await reopened.forExtension({
        extensionId: 'example.first',
        migrations: firstMigrations,
      });
      await reopened.forExtension({
        extensionId: 'example.second',
        migrations: secondMigrations,
      });
      expect(
        await again.transact((transaction) =>
          transaction.all('SELECT text FROM example_first_records', [], (row) => row),
        ),
      ).toEqual([{ text: 'remembered' }]);
      expect(
        await again.transact((transaction) =>
          transaction.all(
            'SELECT extension_id, name FROM nox_migrations ORDER BY extension_id, name',
            [],
            (row) => row,
          ),
        ),
      ).toEqual([
        { extension_id: 'example.first', name: '0001_records.sql' },
        { extension_id: 'example.first', name: '0002_index.sql' },
        { extension_id: 'example.second', name: '0001_records.sql' },
      ]);
      await reopened.close();
    } finally {
      discard(firstMigrations);
      discard(secondMigrations);
      discard(directory);
    }
  });

  test('loads vector search once for the shared extension connection', async () => {
    const directory = temporary('nox-extension-state-');
    const migrations = temporary('nox-extension-migrations-');
    try {
      // What a memory will actually declare: the scope is a partition key, so a
      // nearest-neighbour search never ranks one principal against another.
      writeFileSync(
        join(migrations, '0001_vectors.sql'),
        'CREATE VIRTUAL TABLE example_fact_vectors USING vec0(' +
          'scope TEXT PARTITION KEY, fact_id INTEGER PRIMARY KEY, embedding float[4])',
      );

      const provider = new DatabaseExtensionStorageProvider({ path: extensionPath(directory) });
      const storage = await provider.forExtension({ extensionId: 'example.vectors', migrations });
      const vector = (values: readonly number[]): Uint8Array =>
        new Uint8Array(Float32Array.from(values).buffer);

      await storage.transact((transaction) => {
        transaction.run(
          'INSERT INTO example_fact_vectors (scope, fact_id, embedding) VALUES (?, ?, ?)',
          ['alice', 1, vector([1, 0, 0, 0])],
        );
        transaction.run(
          'INSERT INTO example_fact_vectors (scope, fact_id, embedding) VALUES (?, ?, ?)',
          ['alice', 2, vector([0, 1, 0, 0])],
        );
        transaction.run(
          'INSERT INTO example_fact_vectors (scope, fact_id, embedding) VALUES (?, ?, ?)',
          ['bob', 3, vector([1, 0, 0, 0])],
        );
      });

      const nearest = await storage.transact((transaction) =>
        transaction.all(
          'SELECT fact_id FROM example_fact_vectors ' +
            'WHERE scope = ? AND embedding MATCH ? AND k = ? ORDER BY distance',
          ['alice', vector([0.9, 0.1, 0, 0]), 2],
          (row) => row,
        ),
      );

      // Bob's identical vector is not merely ranked lower, it is not a candidate.
      expect(nearest).toEqual([{ fact_id: 1 }, { fact_id: 2 }]);
      await provider.close();
    } finally {
      discard(migrations);
      discard(directory);
    }
  });

  test('refuses to activate on a migration that will not apply', async () => {
    const directory = temporary('nox-extension-state-');
    const migrations = temporary('nox-extension-migrations-');
    try {
      writeFileSync(join(migrations, '0001_broken.sql'), 'CREATE TABLE (');
      const provider = new DatabaseExtensionStorageProvider({ path: extensionPath(directory) });

      expect(
        provider.forExtension({ extensionId: 'example.broken', migrations }),
      ).rejects.toThrow('0001_broken.sql');
      await provider.close();
    } finally {
      discard(migrations);
      discard(directory);
    }
  });

  test('copies state an older Nox kept in the kernel database', async () => {
    const directory = temporary('nox-extension-state-');
    const kernelDirectory = temporary('nox-kernel-');
    const path = extensionPath(directory);
    let kernel: Database | undefined;
    try {
      kernel = await Database.open({ path: join(kernelDirectory, 'nox.db') });
      await kernel.transaction((transaction) => {
        transaction
          .insert(extensionState)
          .values({
            collection: 'jobs',
            extensionId: 'example.legacy',
            key: 'nightly',
            value: JSON.stringify({ cron: '0 3 * * *' }),
          })
          .run();
      });

      const provider = new DatabaseExtensionStorageProvider({ kernel, path });
      const storage = await provider.forExtension({ extensionId: 'example.legacy' });

      // Whatever an operator had scheduled survives the move; losing it would
      // be a silent data loss on an upgrade nobody asked for.
      expect(await storage.transact((transaction) => transaction.entries('jobs', parseJson))).toEqual(
        [{ key: 'nightly', value: { cron: '0 3 * * *' } }],
      );

      await storage.transact((transaction) => {
        transaction.delete('jobs', 'nightly');
      });
      await provider.close();

      // Recorded per extension, so the deletion is not undone by a second import.
      const reopened = new DatabaseExtensionStorageProvider({ kernel, path });
      const again = await reopened.forExtension({ extensionId: 'example.legacy' });
      expect(await again.transact((transaction) => transaction.entries('jobs', parseJson))).toEqual(
        [],
      );
      await reopened.close();
    } finally {
      await kernel?.close();
      discard(kernelDirectory);
      discard(directory);
    }
  });
});
