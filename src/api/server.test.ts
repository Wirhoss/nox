import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { ApiServer, type ApiServerOptions } from './server';

/** Binds an ephemeral port, so tests never collide with a running Nox. */
async function withServer(
  options: ApiServerOptions,
  body: (server: ApiServer) => Promise<void>,
): Promise<void> {
  const server = ApiServer.create({ host: '127.0.0.1', port: 0, ...options });
  await server.listen();
  try {
    await body(server);
  } finally {
    await server.dispose();
  }
}

describe('liveness', () => {
  test('passes while the process answers, whatever its dependencies say', async () => {
    await withServer({ checks: { database: () => false }, version: '0.1.0' }, async (server) => {
      const response = await fetch(`${server.url}/health/live`);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'pass', version: '0.1.0' });
    });
  });
});

describe('readiness', () => {
  test('passes when every check passes', async () => {
    await withServer(
      { checks: { application: () => true, database: () => Promise.resolve(true) } },
      async (server) => {
        const response = await fetch(`${server.url}/health/ready`);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          checks: { application: 'pass', database: 'pass' },
          status: 'pass',
        });
      },
    );
  });

  test('is 503 with every check reported, not just the first failure', async () => {
    await withServer(
      {
        checks: {
          application: () => true,
          database: () => false,
          provider: () => {
            throw new Error('unreachable');
          },
        },
      },
      async (server) => {
        const response = await fetch(`${server.url}/health/ready`);

        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          checks: { application: 'pass', database: 'fail', provider: 'fail' },
          status: 'fail',
        });
      },
    );
  });

  test('passes with nothing to check', async () => {
    await withServer({}, async (server) => {
      const response = await fetch(`${server.url}/health/ready`);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ checks: {}, status: 'pass' });
    });
  });
});

describe('web UI', () => {
  test('serves built assets and the SPA document without swallowing API 404s', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nox-ui-'));
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'index.html'), '<!doctype html><title>Nox UI</title>');
    await writeFile(join(directory, 'assets', 'app-a1b2c3d4.js'), 'window.nox = true;');

    try {
      await withServer({ uiDirectory: directory }, async (server) => {
        const root = await fetch(`${server.url}/`);
        expect(root.status).toBe(200);
        expect(root.headers.get('content-type')).toContain('text/html');
        expect(root.headers.get('cache-control')).toBe('no-cache');
        expect(await root.text()).toContain('Nox UI');

        const clientRoute = await fetch(`${server.url}/access`);
        expect(clientRoute.status).toBe(200);
        expect(await clientRoute.text()).toContain('Nox UI');

        const asset = await fetch(`${server.url}/assets/app-a1b2c3d4.js`);
        expect(asset.status).toBe(200);
        expect(asset.headers.get('cache-control')).toContain('immutable');
        expect(await asset.text()).toBe('window.nox = true;');

        expect((await fetch(`${server.url}/assets/missing.js`)).status).toBe(404);
        expect((await fetch(`${server.url}/auth/missing`)).status).toBe(404);
        expect((await fetch(`${server.url}/chat/missing`)).status).toBe(404);
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe('the server itself', () => {
  test('reports the port it actually bound to', async () => {
    await withServer({}, (server) => {
      expect(server.url).not.toContain(':0');
      return Promise.resolve();
    });
  });

  test('stops once, however many times it is disposed', async () => {
    const server = ApiServer.create({ host: '127.0.0.1', port: 0 });
    await server.listen();
    await server.dispose();

    await server.dispose();
  });
});
