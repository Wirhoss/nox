import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { Database } from '../database/database';
import { secrets } from '../database/schema';
import { resolveSecrets, SecretError, SecretHandle, secretRefSchema, SecretStore } from './secrets';

const databases: Database[] = [];
const directories: string[] = [];

function ref(secretId: string) {
  return secretRefSchema.parse({ $secret: secretId });
}

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nox-secrets-'));
  directories.push(directory);
  return directory;
}

async function openStore(existingDirectory?: string): Promise<{
  database: Database;
  directory: string;
  store: SecretStore;
}> {
  const directory = existingDirectory ?? (await dataDirectory());
  const database = await Database.open({ path: join(directory, 'nox.db') });
  databases.push(database);
  const store = await SecretStore.open({ dataDirectory: directory, database });
  return { database, directory, store };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      // Windows can retain a SQLite handle briefly after close; the OS temp
      // directory is disposable, so cleanup timing is not the assertion here.
      await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    }),
  );
});

describe('secret references', () => {
  test('are opaque config values, never inline strings or paths', () => {
    expect(ref('DISCORD_BOT_TOKEN').$secret).toBe('DISCORD_BOT_TOKEN');
    expect(secretRefSchema.safeParse('inline-token').success).toBeFalse();
    expect(secretRefSchema.safeParse({ $secret: '../token' }).success).toBeFalse();
  });
});

describe('SecretStore', () => {
  test('creates an encrypted managed secret and returns only safe metadata', async () => {
    const { database, directory, store } = await openStore();
    const metadata = await store.set('API_TOKEN', 'very-secret');
    const consumer = { extensionId: 'nox.test', location: 'providers.main.apiKey' };

    const handle = await store.resolve(ref('API_TOKEN'), consumer);
    const row = database.db.select().from(secrets).get();

    expect(metadata.createdAt).toBeNumber();
    expect(metadata.secretId).toBe('API_TOKEN');
    expect(metadata.updatedAt).toBeNumber();
    expect(await store.list()).toEqual([metadata]);
    expect(await store.has('API_TOKEN')).toBeTrue();
    expect(handle).toBeInstanceOf(SecretHandle);
    expect(handle.id).toBe('API_TOKEN');
    expect(handle.reveal()).toBe('very-secret');
    expect(String(handle)).toBe('[redacted]');
    expect(JSON.stringify({ handle })).toBe('{"handle":"[redacted]"}');
    expect(JSON.stringify(row)).not.toContain('very-secret');
    expect(await readFile(join(directory, '.secret-key'))).toHaveLength(32);
    expect(store.consumers('API_TOKEN')).toEqual([consumer]);
  });

  test('persists across a database reopen with the same installation key', async () => {
    const first = await openStore();
    await first.store.set('API_TOKEN', 'survives-restart');
    await first.database.close();

    const second = await openStore(first.directory);
    const handle = await second.store.resolve(ref('API_TOKEN'), {
      extensionId: 'nox.test',
      location: 'providers.main.apiKey',
    });

    expect(handle.reveal()).toBe('survives-restart');
  });

  test('rotates future handles while existing handles remain immutable snapshots', async () => {
    const { store } = await openStore();
    const consumer = { extensionId: 'nox.test', location: 'providers.main.apiKey' };
    const created = await store.set('API_TOKEN', 'first');
    const first = await store.resolve(ref('API_TOKEN'), consumer);

    const replaced = await store.set('API_TOKEN', 'second');
    const second = await store.resolve(ref('API_TOKEN'), consumer);

    expect(first.reveal()).toBe('first');
    expect(second.reveal()).toBe('second');
    expect(replaced.createdAt).toBe(created.createdAt);
    expect(replaced.updatedAt).toBeGreaterThan(created.updatedAt);
    expect(await store.list()).toHaveLength(1);
  });

  test('resolves every nested reference and records each legitimate consumer', async () => {
    const { store } = await openStore();
    await store.set('SHARED_TOKEN', 'shared');

    const resolved = await resolveSecrets(
      {
        extract: { apiKey: ref('SHARED_TOKEN') },
        search: { apiKey: ref('SHARED_TOKEN') },
      },
      store,
      { extensionId: 'nox.toolset.web', location: 'toolSets.internet' },
    );

    expect(resolved.extract.apiKey.reveal()).toBe('shared');
    expect(resolved.search.apiKey.reveal()).toBe('shared');
    expect(store.consumers('SHARED_TOKEN')).toEqual([
      { extensionId: 'nox.toolset.web', location: 'toolSets.internet.extract.apiKey' },
      { extensionId: 'nox.toolset.web', location: 'toolSets.internet.search.apiKey' },
    ]);
  });

  test('lets separate extensions deliberately share one secret ID', async () => {
    const { store } = await openStore();
    await store.set('DISCORD_BOT_TOKEN', 'shared-token');

    const broker = await store.resolve(ref('DISCORD_BOT_TOKEN'), {
      extensionId: 'nox.broker.discord',
      location: 'brokers.discord.token',
    });
    const toolSet = await store.resolve(ref('DISCORD_BOT_TOKEN'), {
      extensionId: 'nox.toolset.discord',
      location: 'toolSets.discord-admin.token',
    });

    expect(broker.reveal()).toBe(toolSet.reveal());
    expect(store.consumers('DISCORD_BOT_TOKEN')).toEqual([
      { extensionId: 'nox.broker.discord', location: 'brokers.discord.token' },
      { extensionId: 'nox.toolset.discord', location: 'toolSets.discord-admin.token' },
    ]);
  });

  test('rejects an empty managed value without creating a record', async () => {
    const { store } = await openStore();

    expect(store.set('API_TOKEN', '')).rejects.toThrow('cannot be empty');
    expect(await store.list()).toEqual([]);
  });

  test('deletes managed values without exposing them', async () => {
    const { store } = await openStore();
    await store.set('API_TOKEN', 'delete-me');

    expect(await store.delete('API_TOKEN')).toBeTrue();
    expect(await store.delete('API_TOKEN')).toBeFalse();
    expect(await store.has('API_TOKEN')).toBeFalse();
    expect(await store.list()).toEqual([]);
    expect(
      store.resolve(ref('API_TOKEN'), {
        extensionId: 'nox.test',
        location: 'providers.main.apiKey',
      }),
    ).rejects.toMatchObject({ code: 'missing' });
  });

  test('fails closed without putting secret values in diagnostics', async () => {
    const { store } = await openStore();

    const failure = store.resolve(ref('MISSING_TOKEN'), {
      extensionId: 'nox.provider.test',
      location: 'providers.main.apiKey',
    });

    expect(failure).rejects.toBeInstanceOf(SecretError);
    expect(failure).rejects.toThrow('MISSING_TOKEN');
    expect(failure).rejects.toThrow('providers.main.apiKey');
  });

  test('detects a modified encrypted envelope', async () => {
    const { database, store } = await openStore();
    await store.set('API_TOKEN', 'must-not-leak');
    await database.exclusive((db) => {
      db.update(secrets)
        .set({ authTag: Buffer.alloc(16).toString('base64') })
        .where(eq(secrets.secretId, 'API_TOKEN'))
        .run();
    });

    const failure = store.resolve(ref('API_TOKEN'), {
      extensionId: 'nox.test',
      location: 'brokers.discord.token',
    });

    expect(failure).rejects.toMatchObject({ code: 'unreadable' });
    expect(String(await failure.catch((error: unknown) => error))).not.toContain('must-not-leak');
  });

  test('never regenerates a missing key over encrypted data', async () => {
    const first = await openStore();
    await first.store.set('API_TOKEN', 'still-encrypted');
    await first.database.close();
    await unlink(join(first.directory, '.secret-key'));

    const database = await Database.open({ path: join(first.directory, 'nox.db') });
    databases.push(database);

    expect(SecretStore.open({ dataDirectory: first.directory, database })).rejects.toThrow(
      'refusing to replace',
    );
  });

  test('refuses an invalid local master key instead of silently replacing it', async () => {
    const directory = await dataDirectory();
    await writeFile(join(directory, '.secret-key'), 'too-short');
    const database = await Database.open({ path: join(directory, 'nox.db') });
    databases.push(database);

    expect(SecretStore.open({ dataDirectory: directory, database })).rejects.toThrow('32 bytes');
  });
});
