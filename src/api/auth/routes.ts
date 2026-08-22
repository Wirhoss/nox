import { Elysia } from 'elysia';
import { z } from 'zod';

import { API_PREFIX } from '../prefix';
import { authGuard } from './guard';
import { type Account, AccountExistsError, type AuthStore, type TokenPair } from './store';

import type { RegistrationWindow } from './registration';

/**
 * Scoped to `/api/auth`, so the browser attaches it only to the routes that trade it
 * for an access token. Every other request carries the access token instead, and
 * a cookie the browser never sends is a cookie that cannot be used against it.
 */
const REFRESH_COOKIE = 'nox_refresh';
const REFRESH_COOKIE_PATH = `${API_PREFIX}/auth`;

const credentialsSchema = z.object({
  password: z.string().min(8).max(200),
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, digits, dots, dashes or underscores.'),
});

const registrationSchema = credentialsSchema.extend({
  code: z.string().min(1).max(64),
});

interface AuthRoutesOptions {
  readonly registration: RegistrationWindow;
  readonly store: AuthStore;
}

/**
 * The only routes that answer without a token, and the reason the rest can
 * demand one.
 *
 * The refresh token leaves in a cookie the browser will not show to JavaScript;
 * the access token leaves in the body, for the client to hold in memory and send
 * back as a bearer. Splitting them that way means an XSS gets a token that dies
 * in minutes rather than the one that renews it for a month.
 */
function createAuthRoutes(options: AuthRoutesOptions) {
  const { registration, store } = options;

  return (
    new Elysia({ name: 'nox.api.auth.routes' })
      .use(authGuard(store))

      /**
       * What the installer needs before it can draw anything: a fresh Nox shows a
       * registration form, a claimed one shows a login. Unauthenticated because
       * nobody can have a token yet, and it discloses only what the first screen
       * would reveal anyway.
       */
      .get('/auth/status', async () => ({ registered: await store.isRegistered() }))

      .post(
        '/auth/register',
        async ({ body, cookie, status }) => {
          if (await store.isRegistered()) return status(409, { error: 'already_registered' });
          if (!registration.accepts(body.code)) return status(403, { error: 'invalid_code' });

          let account: Account;
          try {
            account = await store.register(body.username, body.password);
          } catch (error) {
            // Lost the race against another registration for the same empty Nox.
            if (error instanceof AccountExistsError) {
              return status(409, { error: 'already_registered' });
            }
            throw error;
          }

          // Only now: a code burnt before the account existed would leave an
          // unclaimable Nox behind if anything above had failed.
          registration.close();

          const tokens = await store.openSession(account.accountId);
          setRefreshCookie(cookie, tokens, store);
          return status(201, session(account, tokens));
        },
        { body: registrationSchema },
      )

      .post(
        '/auth/login',
        async ({ body, cookie, status }) => {
          const account = await store.authenticate(body.username, body.password);
          if (account === undefined) return status(401, { error: 'invalid_credentials' });

          const tokens = await store.openSession(account.accountId);
          setRefreshCookie(cookie, tokens, store);
          return session(account, tokens);
        },
        { body: credentialsSchema },
      )

      /**
       * Renews the pair from the cookie alone. It deliberately does not require a
       * live access token — the whole reason a client is here is that the one it
       * had ran out.
       */
      .post('/auth/refresh', async ({ cookie, status }) => {
        const presented = cookie[REFRESH_COOKIE]?.value;
        if (typeof presented !== 'string' || presented.length === 0) {
          return status(401, { error: 'unauthorized' });
        }

        const tokens = await store.refresh(presented);
        if (tokens === undefined) {
          clearRefreshCookie(cookie, store);
          return status(401, { error: 'unauthorized' });
        }

        setRefreshCookie(cookie, tokens, store);
        return { accessToken: tokens.accessToken, expiresInSeconds: tokens.expiresInSeconds };
      })

      /**
       * Ends the login the cookie names, not the one the access token names: a
       * client whose access token has already expired must still be able to log
       * out. Always 204 — whether a session was there to end is not the caller's
       * business, and it changes nothing about what to do next.
       */
      .post('/auth/logout', async ({ cookie, status }) => {
        const presented = cookie[REFRESH_COOKIE]?.value;
        if (typeof presented === 'string' && presented.length > 0) {
          await store.revokeByRefreshToken(presented);
        }

        clearRefreshCookie(cookie, store);
        return status(204, undefined);
      })

      /** Who the caller is, for a client restoring its state from a token it already holds. */
      .get('/auth/me', ({ account }) => ({ account }), { authenticated: true })
  );
}

/** The body shape shared by register and login. The refresh token is never in it. */
function session(account: Account, tokens: TokenPair) {
  return {
    accessToken: tokens.accessToken,
    account,
    expiresInSeconds: tokens.expiresInSeconds,
  };
}

type CookieJar = Record<string, { remove: () => void; set: (options: CookieOptions) => void }>;

interface CookieOptions {
  expires?: Date;
  httpOnly?: boolean;
  path?: string;
  sameSite?: 'lax' | 'strict';
  secure?: boolean;
  value?: string;
}

function setRefreshCookie(cookie: CookieJar, tokens: TokenPair, store: AuthStore): void {
  cookie[REFRESH_COOKIE]?.set({
    expires: new Date(tokens.refreshExpiresAt),
    httpOnly: true,
    path: REFRESH_COOKIE_PATH,
    // Strict, not lax: no third-party page has any reason to start a request
    // that renews someone's Nox session.
    sameSite: 'strict',
    secure: store.config.secureCookies,
    value: tokens.refreshToken,
  });
}

function clearRefreshCookie(cookie: CookieJar, store: AuthStore): void {
  cookie[REFRESH_COOKIE]?.set({
    expires: new Date(0),
    httpOnly: true,
    path: REFRESH_COOKIE_PATH,
    sameSite: 'strict',
    secure: store.config.secureCookies,
    value: '',
  });
}

function authRoutes(options: AuthRoutesOptions): ReturnType<typeof createAuthRoutes> {
  return createAuthRoutes(options);
}

export { authRoutes, REFRESH_COOKIE };

export type { AuthRoutesOptions };
