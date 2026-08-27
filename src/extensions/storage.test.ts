import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { Database } from '../database/database';
import { DatabaseExtensionStorageProvider, MemoryExtensionStorageProvider } from './storage';

const parseJson = (value: unknown): unknown => value;

describe('extension storage', () => {
  test('isolates state by extension and rolls back failed transactions', async () => {
    const provider = new MemoryExtensionStorageProvider();
    const first = provider.forExtension('example.first');
    const second = provider.forExtension('example.second');

    await first.transact((transaction) => {
      transaction.set('settings', 'theme', { name: 'dark' });
    });
    expect(
      await first.transact((transaction) => transaction.get('settings', 'theme', parseJson)),
    ).toEqual({ name: 'dark' });
    expect(
      await second.transact((transaction) => transaction.get('settings', 'theme', parseJson)),
    ).toBeUndefined();

    expect(
      first.transact((transaction) => {
        transaction.set('settings', 'theme', { name: 'light' });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(
      await first.transact((transaction) => transaction.get('settings', 'theme', parseJson)),
    ).toEqual({ name: 'dark' });
  });

  test('persists JSON documents through database-backed provider instances', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nox-extension-state-'));
    const path = join(directory, 'nox.db');
    let database: Database | undefined;
    try {
      database = await Database.open({ path });
      const first = new DatabaseExtensionStorageProvider(database).forExtension('example.state');
      await first.transact((transaction) => {
        transaction.set('documents', 'one', { value: 7 });
        transaction.set('documents', 'two', ['a', 'b']);
      });
      await database.close();

      database = await Database.open({ path });
      const reopened = new DatabaseExtensionStorageProvider(database).forExtension('example.state');
      expect(
        await reopened.transact((transaction) => transaction.entries('documents', parseJson)),
      ).toEqual([
        { key: 'one', value: { value: 7 } },
        { key: 'two', value: ['a', 'b'] },
      ]);
    } finally {
      await database?.close();
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        // Windows may retain a closed SQLite handle briefly; the temp path is disposable.
      }
    }
  });
});
