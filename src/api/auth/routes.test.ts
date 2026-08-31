import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { Database } from '../../database/database';
import { silentLogger } from '../../logger/logger';
import { ApiServer } from '../server';
import { RegistrationWindow } from './registration';
import { AuthStore } from './store';

import type { Logger } from '../../logger/logger';

const databases: Database[] = [];
const directories: string[] = [];
const servers: ApiServer[] = [];

const PASSWORD = 'correct-horse-battery';

/** A Nox nobody has claimed yet, listening on an ephemeral port with its code in hand. */
async function freshNox(): Promise<{ code: string; url: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'nox-auth-routes-'));
  directories.push(directory);
  const database = await Database.open({ logger: silentLogger, path: join(directory, 'nox.db') });
  databases.push(database);

  const store = await AuthStore.open({ database, dataDirectory: directory, logger: silentLogger });

  let code = '';
  const recording: Logger = {
    ...silentLogger,
    info: (fields): void => {
      if (typeof fields.code === 'string') code = fields.code;
    },
  };
  const registration = RegistrationWindow.open(recording);

  const server = ApiServer.create({
    auth: { registration, store },
    host: '127.0.0.1',
    logger: silentLogger,
    port: 0,
  });
  await server.listen();
  servers.push(server);

  return { code, url: `${server.url}/api` };
}

/** A Nox already claimed by `wirhoss`, and a live access token for them. */
async function claimedNox(): Promise<{ accessToken: string; refreshCookie: string; url: string }> {
  const { code, url } = await freshNox();
  const response = await postJson(`${url}/auth/register`, {
    code,
    password: PASSWORD,
    username: 'wirhoss',
  });

  const body = (await response.json()) as { accessToken: string };
  return { accessToken: body.accessToken, refreshCookie: refreshCookieOf(response), url };
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  });
}

/**
 * Bun's fetch keeps no cookie jar, so the browser's part of the exchange is done
 * by hand — which also makes it visible what the browser is actually being asked
 * to store and send back.
 */
function refreshCookieOf(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  return header.split(';')[0] ?? '';
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

describe('the install flow', () => {
  test('an unclaimed Nox says so, so the UI knows to show a registration form', async () => {
    const { url } = await freshNox();

    const response = await fetch(`${url}/auth/status`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ registered: false });
  });

  test('registering without the code from the log is refused', async () => {
    const { url } = await freshNox();

    const response = await postJson(`${url}/auth/register`, {
      code: 'NOX-AAAA-AAAA-AAAA',
      password: PASSWORD,
      username: 'wirhoss',
    });

    expect(response.status).toBe(403);
    expect(await fetch(`${url}/auth/status`).then((r) => r.json())).toEqual({ registered: false });
  });

  test('registering with it claims the Nox and signs the operator straight in', async () => {
    const { code, url } = await freshNox();

    const response = await postJson(`${url}/auth/register`, {
      code,
      password: PASSWORD,
      username: 'wirhoss',
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ account: { username: 'wirhoss' } });
    expect(await fetch(`${url}/auth/status`).then((r) => r.json())).toEqual({ registered: true });
  });

  test('the code stops working the moment the account exists', async () => {
    const { code, url } = await freshNox();
    await postJson(`${url}/auth/register`, { code, password: PASSWORD, username: 'wirhoss' });

    const second = await postJson(`${url}/auth/register`, {
      code,
      password: PASSWORD,
      username: 'intruso',
    });

    expect(second.status).toBe(409);
  });

  test('a password too short to be one is refused before anything is stored', async () => {
    const { code, url } = await freshNox();

    const response = await postJson(`${url}/auth/register`, {
      code,
      password: 'short',
      username: 'wirhoss',
    });

    expect(response.status).toBe(422);
    expect(await fetch(`${url}/auth/status`).then((r) => r.json())).toEqual({ registered: false });
  });
});

describe('tokens on the wire', () => {
  test('the refresh token leaves in an HttpOnly cookie, never in the body', async () => {
    const { code, url } = await freshNox();

    const response = await postJson(`${url}/auth/register`, {
      code,
      password: PASSWORD,
      username: 'wirhoss',
    });

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('nox_refresh=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/api/auth');
    expect(Object.keys((await response.json()) as object).sort()).toEqual([
      'accessToken',
      'account',
      'expiresInSeconds',
    ]);
  });
});

describe('login', () => {
  test('the right password comes back with a token', async () => {
    const { url } = await claimedNox();

    const response = await postJson(`${url}/auth/login`, {
      password: PASSWORD,
      username: 'wirhoss',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account: { username: 'wirhoss' } });
  });

  test('a wrong password is 401 and says nothing about which half was wrong', async () => {
    const { url } = await claimedNox();

    const wrongPassword = await postJson(`${url}/auth/login`, {
      password: 'wrong-password-entirely',
      username: 'wirhoss',
    });
    const wrongUser = await postJson(`${url}/auth/login`, {
      password: PASSWORD,
      username: 'nadie',
    });

    expect(wrongPassword.status).toBe(401);
    expect(await wrongPassword.json()).toEqual({ error: 'invalid_credentials' });
    expect(await wrongUser.json()).toEqual({ error: 'invalid_credentials' });
  });
});

describe('the guard', () => {
  test('lets a valid token through to who it belongs to', async () => {
    const { accessToken, url } = await claimedNox();

    const response = await fetch(`${url}/auth/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account: { username: 'wirhoss' } });
  });

  test('turns away a request with no token, a bad one, or the wrong scheme', async () => {
    const { accessToken, url } = await claimedNox();

    const none = await fetch(`${url}/auth/me`);
    const garbage = await fetch(`${url}/auth/me`, { headers: { authorization: 'Bearer nope' } });
    const wrongScheme = await fetch(`${url}/auth/me`, {
      headers: { authorization: `Basic ${accessToken}` },
    });

    expect([none.status, garbage.status, wrongScheme.status]).toEqual([401, 401, 401]);
  });

  test('leaves the health probes alone, which have no credentials to offer', async () => {
    const { url } = await claimedNox();

    expect((await fetch(`${url}/health/live`)).status).toBe(200);
    expect((await fetch(`${url}/health/ready`)).status).toBe(200);
  });
});

describe('refresh and logout', () => {
  test('the cookie alone renews an access token', async () => {
    const { refreshCookie, url } = await claimedNox();

    const response = await postJson(`${url}/auth/refresh`, {}, { cookie: refreshCookie });

    expect(response.status).toBe(200);
    const renewed = (await response.json()) as { accessToken: string };
    const me = await fetch(`${url}/auth/me`, {
      headers: { authorization: `Bearer ${renewed.accessToken}` },
    });
    expect(me.status).toBe(200);
  });

  test('refreshing without the cookie is 401', async () => {
    const { url } = await claimedNox();

    const response = await postJson(`${url}/auth/refresh`, {});

    expect(response.status).toBe(401);
  });

  test('logging out kills the access token that was already issued', async () => {
    const { accessToken, refreshCookie, url } = await claimedNox();

    const response = await postJson(`${url}/auth/logout`, {}, { cookie: refreshCookie });

    expect(response.status).toBe(204);
    const me = await fetch(`${url}/auth/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.status).toBe(401);
  });

  test('the refresh cookie is dead after a logout, so the session cannot be resumed', async () => {
    const { refreshCookie, url } = await claimedNox();
    await postJson(`${url}/auth/logout`, {}, { cookie: refreshCookie });

    const response = await postJson(`${url}/auth/refresh`, {}, { cookie: refreshCookie });

    expect(response.status).toBe(401);
  });

  test('logging out twice is still 204: it changes nothing for the caller', async () => {
    const { refreshCookie, url } = await claimedNox();

    await postJson(`${url}/auth/logout`, {}, { cookie: refreshCookie });
    const second = await postJson(`${url}/auth/logout`, {}, { cookie: refreshCookie });

    expect(second.status).toBe(204);
  });
});
