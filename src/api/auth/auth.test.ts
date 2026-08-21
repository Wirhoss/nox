import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { Database } from '../../database/database';
import { accounts } from '../../database/schema';
import { type Logger, silentLogger } from '../../logger/logger';
import { RegistrationWindow } from './registration';
import { AccountExistsError, AuthStore } from './store';

const databases: Database[] = [];
const directories: string[] = [];

const PASSWORD = 'correct-horse-battery';

/**
 * A store over its own database file, so no two tests share an account. The
 * database comes back with it for the few assertions that are about what was
 * written rather than about what the store will say.
 */
async function openStore(
  options: { accessTtlSeconds?: number } = {},
): Promise<{ database: Database; store: AuthStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'nox-auth-'));
  directories.push(directory);
  const database = await Database.open({ logger: silentLogger, path: join(directory, 'nox.db') });
  databases.push(database);

  const store = await AuthStore.open({
    ...options,
    database,
    dataDirectory: directory,
    logger: silentLogger,
  });
  return { database, store };
}

/**
 * A window and the code it printed. The window keeps its code private, which is
 * the point of it — so a test reads it back off the log, exactly like the
 * operator the code was written for.
 */
function openWindow(): { code: string; window: RegistrationWindow } {
  let code = '';
  const recording: Logger = {
    ...silentLogger,
    info: (fields): void => {
      if (typeof fields.code === 'string') code = fields.code;
    },
  };

  const window = RegistrationWindow.open(recording);
  return { code, window };
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

describe('registration', () => {
  test('a fresh Nox is unclaimed until someone registers', async () => {
    const { store } = await openStore();

    expect(await store.isRegistered()).toBe(false);
    await store.register('esteban', PASSWORD);
    expect(await store.isRegistered()).toBe(true);
  });

  test('refuses a second account, because Nox is single user', async () => {
    const { store } = await openStore();
    await store.register('esteban', PASSWORD);

    expect(store.register('otro', PASSWORD)).rejects.toBeInstanceOf(AccountExistsError);
  });

  test('never hands back the password, hashed or otherwise', async () => {
    const { store } = await openStore();

    const account = await store.register('esteban', PASSWORD);

    expect(JSON.stringify(account)).not.toContain(PASSWORD);
    expect(Object.keys(account).sort()).toEqual(['accountId', 'createdAt', 'username']);
  });

  /**
   * The cost of a password is pinned in `PASSWORD_HASHING`, and pinning it is
   * only worth anything if something notices when it moves. Argon2 records the
   * parameters it used in the hash itself, so the row is the evidence: if a Bun
   * upgrade or a stray edit changes the algorithm, the memory or the passes,
   * this is what says so.
   */
  test('stores the password under the argon2id parameters this repo fixed', async () => {
    const { database, store } = await openStore();
    await store.register('esteban', PASSWORD);

    const row = await database.exclusive((db) =>
      db.select({ passwordHash: accounts.passwordHash }).from(accounts).get(),
    );

    expect(row?.passwordHash).toStartWith('$argon2id$v=19$m=65536,t=2,p=1$');
    expect(row?.passwordHash).not.toContain(PASSWORD);
  });
});

describe('the registration window', () => {
  test('accepts the code it printed and nothing else', () => {
    const { code, window } = openWindow();

    expect(window.accepts(code)).toBe(true);
    expect(window.accepts('NOX-AAAA-AAAA-AAAA')).toBe(false);
    expect(window.accepts('')).toBe(false);
  });

  test('accepts nothing once closed, including the code it used to hold', () => {
    const { code, window } = openWindow();

    window.close();

    expect(window.isOpen).toBe(false);
    expect(window.accepts(code)).toBe(false);
  });

  test('an already claimed Nox opens no window at all', () => {
    const window = RegistrationWindow.closed();

    expect(window.isOpen).toBe(false);
    expect(window.accepts('')).toBe(false);
  });
});

describe('authentication', () => {
  test('accepts the right password', async () => {
    const { store } = await openStore();
    const registered = await store.register('esteban', PASSWORD);

    const account = await store.authenticate('esteban', PASSWORD);

    expect(account?.accountId).toBe(registered.accountId);
  });

  test('rejects a wrong password and an unknown username the same way', async () => {
    const { store } = await openStore();
    await store.register('esteban', PASSWORD);

    expect(await store.authenticate('esteban', 'wrong-password-entirely')).toBeUndefined();
    expect(await store.authenticate('nadie', PASSWORD)).toBeUndefined();
  });
});

describe('sessions', () => {
  test('a fresh access token resolves to the account that owns it', async () => {
    const { store } = await openStore();
    const account = await store.register('esteban', PASSWORD);

    const tokens = await store.openSession(account.accountId);
    const resolved = await store.resolve(tokens.accessToken);

    expect(resolved?.account.accountId).toBe(account.accountId);
    expect(resolved?.sessionId).toBe(tokens.sessionId);
  });

  test('a token that was not signed here resolves to nobody', async () => {
    const { store } = await openStore();
    const account = await store.register('esteban', PASSWORD);
    const tokens = await store.openSession(account.accountId);

    const [header, payload] = tokens.accessToken.split('.');

    expect(await store.resolve('not-a-token')).toBeUndefined();
    expect(await store.resolve(`${String(header)}.${String(payload)}.forged`)).toBeUndefined();
  });

  test('revoking kills the access token immediately, not at its expiry', async () => {
    const { store } = await openStore();
    const account = await store.register('esteban', PASSWORD);
    const tokens = await store.openSession(account.accountId);

    expect(await store.resolve(tokens.accessToken)).toBeDefined();
    await store.revoke(tokens.sessionId);

    expect(await store.resolve(tokens.accessToken)).toBeUndefined();
  });

  test('revoking twice is not a failure, it is just already done', async () => {
    const { store } = await openStore();
    const account = await store.register('esteban', PASSWORD);
    const tokens = await store.openSession(account.accountId);

    expect(await store.revoke(tokens.sessionId)).toBe(true);
    expect(await store.revoke(tokens.sessionId)).toBe(false);
  });

  test('one session ending leaves the others alone', async () => {
    const { store } = await openStore();
    const account = await store.register('esteban', PASSWORD);
    const phone = await store.openSession(account.accountId);
    const laptop = await store.openSession(account.accountId);

    await store.revoke(phone.sessionId);

    expect(await store.resolve(phone.accessToken)).toBeUndefined();
    expect(await store.resolve(laptop.accessToken)).toBeDefined();
  });
});

describe('refresh', () => {
  test('trades a refresh token for a working access token', async () => {
    const { store } = await openStore();
    const account = await store.register('esteban', PASSWORD);
    const opened = await store.openSession(account.accountId);

    const renewed = await store.refresh(opened.refreshToken);

    expect(renewed?.sessionId).toBe(opened.sessionId);
    expect(await store.resolve(renewed?.accessToken ?? '')).toBeDefined();
  });

  test('rotates: the token just spent cannot be spent again', async () => {
    const { store } = await openStore();
    const account = await store.register('esteban', PASSWORD);
    const opened = await store.openSession(account.accountId);

    const renewed = await store.refresh(opened.refreshToken);

    expect(renewed).toBeDefined();
    expect(renewed?.refreshToken).not.toBe(opened.refreshToken);
    expect(await store.refresh(opened.refreshToken)).toBeUndefined();
  });

  test('a revoked session cannot be refreshed back to life', async () => {
    const { store } = await openStore();
    const account = await store.register('esteban', PASSWORD);
    const opened = await store.openSession(account.accountId);

    await store.revoke(opened.sessionId);

    expect(await store.refresh(opened.refreshToken)).toBeUndefined();
  });

  test('logging out by refresh token ends the session it names', async () => {
    const { store } = await openStore();
    const account = await store.register('esteban', PASSWORD);
    const opened = await store.openSession(account.accountId);

    expect(await store.revokeByRefreshToken(opened.refreshToken)).toBe(true);

    expect(await store.resolve(opened.accessToken)).toBeUndefined();
    expect(await store.revokeByRefreshToken(opened.refreshToken)).toBe(false);
  });
});
