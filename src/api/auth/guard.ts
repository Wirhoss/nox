import { Elysia } from 'elysia';

import type { Account, AuthStore } from './store';

const BEARER_PREFIX = 'Bearer ';

/** Every way of failing to be authenticated answers the same, and says nothing more. */
const UNAUTHORIZED = { error: 'unauthorized' } as const;

/**
 * What a protected route may assume once it runs: a real account, and the login
 * it is acting under.
 */
interface AuthenticatedContext {
  readonly account: Account;
  readonly sessionId: string;
}

/**
 * Turns a valid access token into a caller, or the request into a 401 before the
 * handler ever runs. Mark a route with `{ authenticated: true }` and it may read
 * `account` and `sessionId` off its context without checking anything itself —
 * which is the point: a route that could forget to check is a route that will.
 *
 * The health probes stay outside this. An orchestrator has no credentials, and
 * asking it to hold some to find out whether Nox is alive gets the dependency
 * backwards.
 */
function createAuthGuard(store: AuthStore) {
  return new Elysia({ name: 'nox.api.auth.guard' }).macro({
    authenticated: {
      async resolve({ headers, status }) {
        const token = bearerToken(headers.authorization);
        if (token === undefined) return status(401, UNAUTHORIZED);

        const authenticated = await store.resolve(token);
        if (authenticated === undefined) return status(401, UNAUTHORIZED);

        return { account: authenticated.account, sessionId: authenticated.sessionId };
      },
    },
  });
}

/** The token out of an `Authorization` header, or nothing if it is not a bearer one. */
function bearerToken(header: string | undefined): string | undefined {
  if (header?.startsWith(BEARER_PREFIX) !== true) return undefined;
  return header.slice(BEARER_PREFIX.length);
}

function authGuard(store: AuthStore): ReturnType<typeof createAuthGuard> {
  return createAuthGuard(store);
}

export { authGuard };

export type { AuthenticatedContext };
