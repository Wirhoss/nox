import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { ArtifactPipeline } from '../../artifact/pipeline';
import { Database } from '../../database/database';
import { artifactBlobs, artifacts } from '../../database/schema';
import { silentLogger } from '../../logger/logger';
import { RegistrationWindow } from '../auth/registration';
import { AuthStore } from '../auth/store';
import { ApiServer } from '../server';

const directories: string[] = [];
const databases: Database[] = [];
const servers: ApiServer[] = [];
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface ArtifactNox {
  readonly accessToken: string;
  readonly artifacts: ArtifactPipeline;
  readonly database: Database;
  readonly url: string;
}

async function artifactNox(): Promise<ArtifactNox> {
  const directory = await mkdtemp(join(tmpdir(), 'nox-artifact-api-'));
  directories.push(directory);
  const database = await Database.open({ path: join(directory, 'nox.db') });
  databases.push(database);
  const pipeline = await ArtifactPipeline.open({ dataDirectory: directory, database });
  const store = await AuthStore.open({ database, dataDirectory: directory });
  const account = await store.register('esteban', 'correct-horse-battery');
  const tokens = await store.openSession(account.accountId);
  const server = ApiServer.create({
    artifacts: pipeline,
    auth: { registration: RegistrationWindow.closed(), store },
    host: '127.0.0.1',
    logger: silentLogger,
    port: 0,
  });
  await server.listen();
  servers.push(server);
  return {
    accessToken: tokens.accessToken,
    artifacts: pipeline,
    database,
    url: `${server.url}/api`,
  };
}

async function upload(nox: ArtifactNox, filename = 'diagram.png'): Promise<Response> {
  return fetch(`${nox.url}/artifacts`, {
    body: PNG,
    headers: {
      authorization: `Bearer ${nox.accessToken}`,
      'content-type': 'image/webp',
      'x-artifact-filename': encodeURIComponent(filename),
    },
    method: 'POST',
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }).catch(() => undefined)),
  );
});

describe('artifact routes', () => {
  test('require authentication in both directions', async () => {
    const nox = await artifactNox();
    expect((await fetch(`${nox.url}/artifacts`, { body: PNG, method: 'POST' })).status).toBe(401);
    expect((await fetch(`${nox.url}/artifacts/art_unknown00/content`)).status).toBe(401);
  });

  test('store once, return references, and stream authenticated bytes back', async () => {
    const nox = await artifactNox();
    const first = await upload(nox, 'first.png');
    const second = await upload(nox, 'second.png');
    const reference = (await first.json()) as {
      artifactId: string;
      filename: string;
      mediaType: string;
      size: number;
    };

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(reference).toMatchObject({ filename: 'first.png', mediaType: 'image/png', size: 8 });
    expect(await nox.database.db.select().from(artifactBlobs)).toHaveLength(1);
    expect(await nox.database.db.select().from(artifacts)).toHaveLength(2);

    const content = await fetch(`${nox.url}/artifacts/${reference.artifactId}/content`, {
      headers: { authorization: `Bearer ${nox.accessToken}` },
    });
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(PNG);
  });

  test('do not reveal an artifact outside the authenticated account scope', async () => {
    const nox = await artifactNox();
    const hidden = await nox.artifacts.ingest({
      data: new Blob([PNG]),
      filename: 'hidden.png',
      provenance: { type: 'upload' },
      scope: { id: 'another-account', type: 'account' },
    });

    const response = await fetch(`${nox.url}/artifacts/${hidden.artifactId}/content`, {
      headers: { authorization: `Bearer ${nox.accessToken}` },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'artifact_not_found' });
  });
});
