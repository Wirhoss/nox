import { describe, expect, test } from 'bun:test';

import { ApiServer, type ApiServerOptions } from './server';

/** Binds an ephemeral port, so tests never collide with a running Nox. */
async function withServer(
  options: ApiServerOptions,
  body: (server: ApiServer) => Promise<void>,
): Promise<void> {
  const server = await ApiServer.start({ host: '127.0.0.1', port: 0, ...options });
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

describe('the server itself', () => {
  test('reports the port it actually bound to', async () => {
    await withServer({}, (server) => {
      expect(server.url).not.toContain(':0');
      return Promise.resolve();
    });
  });

  test('stops once, however many times it is disposed', async () => {
    const server = await ApiServer.start({ host: '127.0.0.1', port: 0 });
    await server.dispose();

    await server.dispose();
  });
});
