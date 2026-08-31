import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { secretRefSchema } from '@nox/extension-api';
import { afterEach, describe, expect, test } from 'bun:test';

import { SecretStore } from '../../config/secrets';
import { Database } from '../../database/database';
import { silentLogger } from '../../logger/logger';
import { RegistrationWindow } from '../auth/registration';
import { AuthStore } from '../auth/store';
import { ApiServer } from '../server';

import type { SecretReference } from '@nox/extension-api';

const databases: Database[] = [];
const directories: string[] = [];
const servers: ApiServer[] = [];

const PASSWORD = 'correct-horse-battery';

function reference(secretId: string, location: string): SecretReference {
  return { location, secretId };
}

interface SecretNox {
  readonly headers: Record<string, string>;
  readonly secrets: SecretStore;
  readonly url: string;
}

/** A claimed Nox with one account logged in and the secret routes mounted. */
async function secretNox(referenced: readonly SecretReference[] = []): Promise<SecretNox> {
  const directory = await mkdtemp(join(tmpdir(), 'nox-secrets-'));
  directories.push(directory);

  const database = await Database.open({ logger: silentLogger, path: join(directory, 'nox.db') });
  databases.push(database);
  const secrets = await SecretStore.open({
    dataDirectory: directory,
    database,
    logger: silentLogger,
    references: () => referenced,
  });
  const store = await AuthStore.open({ database, dataDirectory: directory, logger: silentLogger });
  const account = await store.register('wirhoss', PASSWORD);
  const tokens = await store.openSession(account.accountId);

  const server = ApiServer.create({
    auth: { registration: RegistrationWindow.closed(), store },
    host: '127.0.0.1',
    logger: silentLogger,
    port: 0,
    secrets,
  });
  await server.listen();
  servers.push(server);

  return {
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      'content-type': 'application/json',
    },
    secrets,
    url: `${server.url}/api`,
  };
}

/** Something that composed against this ID and now holds a snapshot of it. */
async function hold(nox: SecretNox, secretId: string): Promise<void> {
  await nox.secrets.resolve(secretRefSchema.parse({ $secret: secretId }), {
    extensionId: 'test.extension',
    location: 'providers.main.apiKey',
  });
}

async function write(nox: SecretNox, secretId: string, value: string): Promise<Response> {
  return fetch(`${nox.url}/secrets/${secretId}`, {
    body: JSON.stringify({ value }),
    headers: nox.headers,
    method: 'PUT',
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      // Windows can retain a SQLite handle briefly after close; the OS temp
      // directory is disposable, so cleanup timing is not the assertion here.
      await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    }),
  );
});

describe('writing secrets', () => {
  test('creates one and never says what it is', async () => {
    const nox = await secretNox();

    const response = await write(nox, 'OPENAI_API_KEY', 'sk-live-value');
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      consumers: [],
      restartRequired: false,
      secretId: 'OPENAI_API_KEY',
    });

    // The one assertion this whole surface exists to keep.
    expect(JSON.stringify(body)).not.toContain('sk-live-value');
  });

  test('replaces one, keeping the ID it was created under', async () => {
    const nox = await secretNox();
    const created = (await (await write(nox, 'TOKEN', 'first')).json()) as { createdAt: number };

    const response = await write(nox, 'TOKEN', 'second');
    const body = (await response.json()) as { createdAt: number; updatedAt: number };

    // 200 rather than 201: the ID was already taken, and saying so is a fact
    // about what happened, not a decision the client had to make first.
    expect(response.status).toBe(200);
    expect(body.createdAt).toBe(created.createdAt);
    expect(body.updatedAt).toBeGreaterThan(created.createdAt);
  });

  test('refuses an empty value', async () => {
    const nox = await secretNox();

    const response = await write(nox, 'TOKEN', '');

    expect(response.status).toBe(422);
  });

  test('refuses an ID that is not one', async () => {
    const nox = await secretNox();

    const response = await write(nox, 'not%2Fa%2Fsecret%2Fid', 'value');

    // Secret IDs are names, not paths, and the schema that says so is the same
    // one every other reader of a `$secret` reference is judged by.
    expect(response.status).toBe(422);
  });
});

describe('reading secrets', () => {
  test('lists what is managed, in a stable order, without any value', async () => {
    const nox = await secretNox();
    await write(nox, 'SECOND', 'b');
    await write(nox, 'FIRST', 'a');

    const response = await fetch(`${nox.url}/secrets`, { headers: nox.headers });
    const body = (await response.json()) as { secrets: { secretId: string }[] };

    expect(response.status).toBe(200);
    expect(body.secrets.map((secret) => secret.secretId)).toEqual(['FIRST', 'SECOND']);
    expect(JSON.stringify(body)).not.toContain('"a"');
  });

  test('reports who resolved one while hot replacement keeps old handles immutable', async () => {
    const nox = await secretNox();
    await write(nox, 'TOKEN', 'value');

    await hold(nox, 'TOKEN');
    const response = await fetch(`${nox.url}/secrets/TOKEN`, { headers: nox.headers });
    const body = (await response.json()) as {
      consumers: { extensionId: string; location: string }[];
      restartRequired: boolean;
    };

    expect(response.status).toBe(200);
    expect(body.consumers).toEqual([
      { extensionId: 'test.extension', location: 'providers.main.apiKey' },
    ]);

    // Existing handles remain snapshots for in-flight turns while future
    // generations reconcile before the write returns.
    expect(body.restartRequired).toBeFalse();
  });

  test('answers 404 for a secret nothing stores', async () => {
    const nox = await secretNox();

    const response = await fetch(`${nox.url}/secrets/GHOST`, { headers: nox.headers });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'secret_not_found' });
  });

  test('lists a secret configuration names before anyone stored a value', async () => {
    const nox = await secretNox([reference('SEARXNG_API_KEY', 'toolSets.internet.search.apiKey')]);

    const response = await fetch(`${nox.url}/secrets`, { headers: nox.headers });
    const body = (await response.json()) as { secrets: Record<string, unknown>[] };

    // The failure this surface exists to prevent: a credential something needs
    // being invisible until a boot fails over it.
    expect(response.status).toBe(200);
    expect(body.secrets).toHaveLength(1);
    expect(body.secrets[0]).toMatchObject({
      consumers: [],
      references: [{ location: 'toolSets.internet.search.apiKey', secretId: 'SEARXNG_API_KEY' }],
      secretId: 'SEARXNG_API_KEY',
      stored: false,
    });
    expect(body.secrets[0]).not.toHaveProperty('createdAt');
    expect(body.secrets[0]).not.toHaveProperty('updatedAt');
  });

  test('reads a referenced secret by ID rather than answering 404', async () => {
    const nox = await secretNox([reference('SEARXNG_API_KEY', 'toolSets.internet.search.apiKey')]);

    const response = await fetch(`${nox.url}/secrets/SEARXNG_API_KEY`, { headers: nox.headers });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ secretId: 'SEARXNG_API_KEY', stored: false });
  });

  test('one ID named by two entries reads as one secret with two references', async () => {
    const nox = await secretNox([
      reference('VENDOR_TOKEN', 'providers.main.apiKey'),
      reference('VENDOR_TOKEN', 'providers.secondary.apiKey'),
    ]);

    const response = await fetch(`${nox.url}/secrets`, { headers: nox.headers });
    const body = (await response.json()) as { secrets: { references: unknown[] }[] };

    // Reuse is the point: one value an operator fills once, named by as many
    // entries as need it.
    expect(body.secrets).toHaveLength(1);
    expect(body.secrets[0]?.references).toHaveLength(2);
  });

  test('writing a referenced secret fills its row instead of adding another', async () => {
    const nox = await secretNox([reference('SEARXNG_API_KEY', 'toolSets.internet.search.apiKey')]);

    const written = await write(nox, 'SEARXNG_API_KEY', 'searxng-token');
    const response = await fetch(`${nox.url}/secrets`, { headers: nox.headers });
    const body = (await response.json()) as { secrets: Record<string, unknown>[] };

    expect(written.status).toBe(201);
    expect(await written.json()).toMatchObject({
      references: [{ location: 'toolSets.internet.search.apiKey' }],
      stored: true,
    });
    expect(body.secrets).toHaveLength(1);
    expect(body.secrets[0]).toMatchObject({ secretId: 'SEARXNG_API_KEY', stored: true });
  });

  test('says nothing at all without a token', async () => {
    const nox = await secretNox();
    await write(nox, 'TOKEN', 'value');

    const list = await fetch(`${nox.url}/secrets`);
    const one = await fetch(`${nox.url}/secrets/TOKEN`);

    expect(list.status).toBe(401);
    expect(one.status).toBe(401);
  });
});

describe('removing secrets', () => {
  test('removes one and reports who was still holding it', async () => {
    const nox = await secretNox();
    await write(nox, 'TOKEN', 'value');
    await hold(nox, 'TOKEN');

    const response = await fetch(`${nox.url}/secrets/TOKEN`, {
      headers: nox.headers,
      method: 'DELETE',
    });
    const body = (await response.json()) as { consumers: unknown[]; restartRequired: boolean };

    // Consumers are reported, not enforced: they are this run's resolutions, so
    // refusing on them would make a secret whose configuration is already gone
    // impossible to remove without restarting first.
    expect(response.status).toBe(200);
    expect(body.consumers).toHaveLength(1);
    expect(body.restartRequired).toBeFalse();
    expect(await nox.secrets.has('TOKEN')).toBeFalse();
  });

  test('deleting the value of a referenced secret leaves the reference listed', async () => {
    const nox = await secretNox([reference('SEARXNG_API_KEY', 'toolSets.internet.search.apiKey')]);
    await write(nox, 'SEARXNG_API_KEY', 'searxng-token');

    const response = await fetch(`${nox.url}/secrets/SEARXNG_API_KEY`, {
      headers: nox.headers,
      method: 'DELETE',
    });
    const body = (await response.json()) as { references: unknown[] };
    const listed = await fetch(`${nox.url}/secrets`, { headers: nox.headers });

    // The value is gone; what names it is not. A list that dropped the ID here
    // would hide a credential the configuration still expects.
    expect(response.status).toBe(200);
    expect(body.references).toHaveLength(1);
    expect(await listed.json()).toMatchObject({
      secrets: [{ secretId: 'SEARXNG_API_KEY', stored: false }],
    });
  });

  test('answers 404 for a secret nothing stores', async () => {
    const nox = await secretNox();

    const response = await fetch(`${nox.url}/secrets/GHOST`, {
      headers: nox.headers,
      method: 'DELETE',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'secret_not_found' });
  });
});
