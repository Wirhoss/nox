import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { secretRefSchema, SecretStore } from '../../config/secrets';
import { Database } from '../../database/database';
import { silentLogger } from '../../logger/logger';
import { RegistrationWindow } from '../auth/registration';
import { AuthStore } from '../auth/store';
import { ApiServer } from '../server';

const databases: Database[] = [];
const directories: string[] = [];
const servers: ApiServer[] = [];

const PASSWORD = 'correct-horse-battery';

interface SecretNox {
  readonly headers: Record<string, string>;
  readonly secrets: SecretStore;
  readonly url: string;
}

/** A claimed Nox with one account logged in and the secret routes mounted. */
async function secretNox(): Promise<SecretNox> {
  const directory = await mkdtemp(join(tmpdir(), 'nox-secrets-'));
  directories.push(directory);

  const database = await Database.open({ logger: silentLogger, path: join(directory, 'nox.db') });
  databases.push(database);
  const secrets = await SecretStore.open({
    dataDirectory: directory,
    database,
    logger: silentLogger,
  });
  const store = await AuthStore.open({ database, dataDirectory: directory, logger: silentLogger });
  const account = await store.register('esteban', PASSWORD);
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

  test('reports who resolved one, and that they keep the old value until a restart', async () => {
    const nox = await secretNox();
    await write(nox, 'TOKEN', 'value');

    await nox.secrets.resolve(secretRefSchema.parse({ $secret: 'TOKEN' }), {
      extensionId: 'test.extension',
      location: 'providers.main.apiKey',
    });
    const response = await fetch(`${nox.url}/secrets/TOKEN`, { headers: nox.headers });
    const body = (await response.json()) as {
      consumers: { extensionId: string; location: string }[];
      restartRequired: boolean;
    };

    expect(response.status).toBe(200);
    expect(body.consumers).toEqual([
      { extensionId: 'test.extension', location: 'providers.main.apiKey' },
    ]);

    // A resolved secret is a snapshot: whoever holds a handle keeps the old
    // value, so a replacement genuinely does wait for a restart.
    expect(body.restartRequired).toBeTrue();
  });

  test('answers 404 for a secret nothing stores', async () => {
    const nox = await secretNox();

    const response = await fetch(`${nox.url}/secrets/GHOST`, { headers: nox.headers });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'secret_not_found' });
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
    await nox.secrets.resolve(secretRefSchema.parse({ $secret: 'TOKEN' }), {
      extensionId: 'test.extension',
      location: 'providers.main.apiKey',
    });

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
    expect(body.restartRequired).toBeTrue();
    expect(await nox.secrets.has('TOKEN')).toBeFalse();
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
