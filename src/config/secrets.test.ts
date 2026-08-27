import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type SecretConsumer, type SecretReference, secretRefSchema } from '@nox/extension-api';
import { afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { Database } from '../database/database';
import { secrets } from '../database/schema';
import {
  composeWithSecrets,
  findSecretReferences,
  resolveSecrets,
  SecretError,
  SecretHandle,
  SecretStore,
} from './secrets';

const databases: Database[] = [];
const directories: string[] = [];

const CONSUMER: SecretConsumer = { extensionId: 'nox.test', location: 'providers.main' };

function ref(secretId: string) {
  return secretRefSchema.parse({ $secret: secretId });
}

function reference(secretId: string, location: string): SecretReference {
  return { location, secretId };
}

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nox-secrets-'));
  directories.push(directory);
  return directory;
}

async function openStore(
  existingDirectory?: string,
  references: readonly SecretReference[] = [],
): Promise<{
  database: Database;
  directory: string;
  store: SecretStore;
}> {
  const directory = existingDirectory ?? (await dataDirectory());
  const database = await Database.open({ path: join(directory, 'nox.db') });
  databases.push(database);
  const store = await SecretStore.open({
    dataDirectory: directory,
    database,
    references: () => references,
  });
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

  test('are found wherever configuration names one, with the path that names it', () => {
    const found = findSecretReferences(
      {
        internet: {
          extract: { apiKey: { $secret: 'CRAWL4AI_API_KEY' }, url: 'https://crawl.example' },
          search: { apiKey: { $secret: 'SEARXNG_API_KEY' }, url: 'https://search.example' },
        },
        plain: { url: 'https://nothing.example' },
      },
      'toolSets',
    );

    expect(found).toEqual([
      reference('CRAWL4AI_API_KEY', 'toolSets.internet.extract.apiKey'),
      reference('SEARXNG_API_KEY', 'toolSets.internet.search.apiKey'),
    ]);
  });

  test('are found inside arrays, which contributed configuration may hold', () => {
    const found = findSecretReferences(
      { relay: { hooks: [{ token: { $secret: 'HOOK' } }] } },
      'brokers',
    );

    expect(found).toEqual([reference('HOOK', 'brokers.relay.hooks.0.token')]);
  });
});

describe('SecretStore', () => {
  test('creates an encrypted managed secret and returns only safe metadata', async () => {
    const { database, directory, store } = await openStore();
    const metadata = await store.set('API_TOKEN', 'very-secret');

    const handle = await store.resolve(ref('API_TOKEN'), CONSUMER);
    const row = database.db.select().from(secrets).get();

    expect(metadata.createdAt).toBeNumber();
    expect(metadata.secretId).toBe('API_TOKEN');
    expect(metadata.updatedAt).toBeNumber();
    expect(await store.list()).toEqual([{ ...metadata, references: [], stored: true }]);
    expect(await store.has('API_TOKEN')).toBeTrue();
    expect(handle).toBeInstanceOf(SecretHandle);
    expect(handle?.id).toBe('API_TOKEN');
    expect(handle?.reveal()).toBe('very-secret');
    expect(String(handle)).toBe('[redacted]');
    expect(JSON.stringify({ handle })).toBe('{"handle":"[redacted]"}');
    expect(JSON.stringify(row)).not.toContain('very-secret');
    expect(await readFile(join(directory, '.secret-key'))).toHaveLength(32);
    expect(store.consumers('API_TOKEN')).toEqual([CONSUMER]);
  });

  test('persists across a database reopen with the same installation key', async () => {
    const first = await openStore();
    await first.store.set('API_TOKEN', 'survives-restart');
    await first.database.close();

    const second = await openStore(first.directory);
    const handle = await second.store.resolve(ref('API_TOKEN'), CONSUMER);

    expect(handle?.reveal()).toBe('survives-restart');
  });

  test('rotates future handles while existing handles remain immutable snapshots', async () => {
    const { store } = await openStore();
    const created = await store.set('API_TOKEN', 'first');
    const first = await store.resolve(ref('API_TOKEN'), CONSUMER);

    const replaced = await store.set('API_TOKEN', 'second');
    const second = await store.resolve(ref('API_TOKEN'), CONSUMER);

    expect(first?.reveal()).toBe('first');
    expect(second?.reveal()).toBe('second');
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

    expect(resolved.value.extract.apiKey.reveal()).toBe('shared');
    expect(resolved.value.search.apiKey.reveal()).toBe('shared');
    expect(resolved.missing).toEqual([]);
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

    expect(broker?.reveal()).toBe(toolSet?.reveal());
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
    expect(await store.resolve(ref('API_TOKEN'), CONSUMER)).toBeUndefined();
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

    // Unreadable is not "unset": it is a broken installation, and treating the
    // two alike would hide a key-management failure behind a puzzling
    // authentication one.
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

describe('secrets configuration names but nobody has stored', () => {
  test('are listed, so a needed credential is never invisible', async () => {
    const { store } = await openStore(undefined, [
      reference('SEARXNG_API_KEY', 'toolSets.internet.search.apiKey'),
    ]);

    expect(await store.list()).toEqual([
      {
        references: [reference('SEARXNG_API_KEY', 'toolSets.internet.search.apiKey')],
        secretId: 'SEARXNG_API_KEY',
        stored: false,
      },
    ]);
    expect(await store.has('SEARXNG_API_KEY')).toBeFalse();
  });

  test('resolve to nothing rather than failing, so a boot is not how you find out', async () => {
    const { store } = await openStore();

    const handle = await store.resolve(ref('SEARXNG_API_KEY'), CONSUMER);

    // Whether a credential is required belongs to whatever reads it, not to the
    // store; a store that threw would make every unfilled optional key a failed
    // boot.
    expect(handle).toBeUndefined();
    expect(store.consumers('SEARXNG_API_KEY')).toEqual([CONSUMER]);
  });

  test('leave their property absent, so an optional field reads as unset', async () => {
    const { store } = await openStore();

    const resolved = await resolveSecrets(
      { apiKey: ref('MISSING'), baseUrl: 'x' },
      store,
      CONSUMER,
    );

    // Not `{ apiKey: undefined }`: that is a present key to a `.parse`, and an
    // optional field has to read as absent for its schema to accept it.
    expect('apiKey' in resolved.value).toBeFalse();
    expect(resolved.value.baseUrl).toBe('x');
    expect(resolved.missing).toEqual([reference('MISSING', 'providers.main.apiKey')]);
  });

  test('writing a value fills the referenced row rather than adding a second one', async () => {
    const { store } = await openStore(undefined, [
      reference('SEARXNG_API_KEY', 'toolSets.internet.search.apiKey'),
    ]);

    const metadata = await store.set('SEARXNG_API_KEY', 'searxng-token');
    const listed = await store.list();

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      createdAt: metadata.createdAt,
      secretId: 'SEARXNG_API_KEY',
      stored: true,
      updatedAt: metadata.updatedAt,
    });
    expect(listed[0]?.references).toHaveLength(1);
  });

  test('deleting the value leaves the reference behind', async () => {
    const { store } = await openStore(undefined, [
      reference('SEARXNG_API_KEY', 'toolSets.internet.search.apiKey'),
    ]);
    await store.set('SEARXNG_API_KEY', 'searxng-token');

    expect(await store.delete('SEARXNG_API_KEY')).toBeTrue();
    expect(await store.list()).toMatchObject([{ secretId: 'SEARXNG_API_KEY', stored: false }]);
  });

  test('stored and referenced IDs are one list, sorted by ID', async () => {
    const { store } = await openStore(undefined, [
      reference('CRAWL4AI_API_KEY', 'toolSets.internet.extract.apiKey'),
      reference('OPENAI_API_KEY', 'providers.main.apiKey'),
    ]);
    await store.set('ZONE_TOKEN', 'stored-only');
    await store.set('OPENAI_API_KEY', 'referenced-and-stored');

    expect((await store.list()).map((summary) => [summary.secretId, summary.stored])).toEqual([
      ['CRAWL4AI_API_KEY', false],
      ['OPENAI_API_KEY', true],
      ['ZONE_TOKEN', true],
    ]);
  });

  test('one ID named twice keeps both locations, which is what reuse looks like', async () => {
    const { store } = await openStore(undefined, [
      reference('VENDOR_TOKEN', 'providers.secondary.apiKey'),
      reference('VENDOR_TOKEN', 'providers.main.apiKey'),
    ]);

    const [summary, ...rest] = await store.list();

    expect(rest).toBeEmpty();
    expect(summary?.references.map((one) => one.location)).toEqual([
      'providers.main.apiKey',
      'providers.secondary.apiKey',
    ]);
  });

  test('references of an unnamed ID read as empty rather than throwing', async () => {
    const { store } = await openStore();
    await store.set('ZONE_TOKEN', 'stored-only');

    expect(store.references('ZONE_TOKEN')).toEqual([]);
    expect(store.references('NEVER_HEARD_OF_IT')).toEqual([]);
  });
});

describe('composeWithSecrets', () => {
  test('hands the factory a config with its credentials in place', async () => {
    const { store } = await openStore();
    await store.set('API_TOKEN', 'live-value');

    const built = await composeWithSecrets(
      { apiKey: ref('API_TOKEN'), baseUrl: 'https://api.example' },
      store,
      CONSUMER,
      (config) => config.apiKey.reveal(),
    );

    expect(built).toBe('live-value');
  });

  test('explains which secret was missing when the factory rejects the gap', async () => {
    const { store } = await openStore();

    const failure = composeWithSecrets(
      { apiKey: ref('DISCORD_TOKEN') },
      store,
      { extensionId: 'nox.broker.discord', location: 'brokers.relay' },
      // What a runtime schema does when a required credential is absent.
      (config) => {
        if (!('apiKey' in config)) throw new TypeError('apiKey is required');
        return config;
      },
    );

    // Without this the only report is a type error naming a field, which says
    // nothing about which credential to store or where it was named.
    expect(failure).rejects.toThrow('brokers.relay');
    expect(failure).rejects.toThrow('DISCORD_TOKEN');
    expect(failure).rejects.toThrow('brokers.relay.apiKey');
  });

  test('leaves an unrelated factory failure exactly as it was thrown', async () => {
    const { store } = await openStore();
    await store.set('API_TOKEN', 'live-value');
    const thrown = new RangeError('baseUrl is required');

    const failure = composeWithSecrets({ apiKey: ref('API_TOKEN') }, store, CONSUMER, () => {
      throw thrown;
    });

    expect(failure).rejects.toBe(thrown);
  });

  test('does not disguise a failure that happens to coincide with a missing secret', async () => {
    const { store } = await openStore();

    const failure = composeWithSecrets({ apiKey: ref('MISSING') }, store, CONSUMER, () => {
      throw new RangeError('something else entirely');
    });

    // The original is kept as the cause: the wrapper adds what the caller could
    // not know, and hides nothing it did.
    expect(failure).rejects.toMatchObject({ cause: { message: 'something else entirely' } });
  });
});

describe('SecretError', () => {
  test('names the secret and the location without carrying a value', async () => {
    const { store } = await openStore();
    await store.set('API_TOKEN', 'must-not-leak');

    const error = new SecretError('missing', 'API_TOKEN', CONSUMER, 'is not configured.');

    expect(error.code).toBe('missing');
    expect(error.secretId).toBe('API_TOKEN');
    expect(String(error)).toContain('providers.main');
    expect(String(error)).not.toContain('must-not-leak');
  });
});
