import { eq, isNotNull, lt, or } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { accounts, authSessions } from '../../database/schema';
import { type Logger, silentLogger } from '../../logger/logger';
import { parseOrThrow } from '../../utils/validate';
import { type AuthConfig, type AuthConfigInput, authConfigSchema } from './config';
import {
  type AccessClaims,
  hashRefreshToken,
  loadOrCreateSigningKey,
  mintRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from './tokens';

import type { Database } from '../../database/database';

/**
 * What a password costs to check, stated here rather than inherited from Bun's
 * defaults: how hard it is to guess one is a decision this repository makes, and
 * a runtime upgrade must not be able to change it underneath us.
 *
 * 64 MiB and two passes, which is above the OWASP minimum for argon2id and runs
 * in roughly 50ms — long enough to ruin brute force, short enough to be
 * invisible in a login. Every stored hash carries the parameters it was made
 * with, so raising these later leaves existing passwords verifying against
 * theirs; only new hashes get the new cost.
 */
const PASSWORD_HASHING = {
  algorithm: 'argon2id',
  memoryCost: 65_536,
  timeCost: 2,
} as const;

/** An account as anything outside this module may see it: never the hash. */
interface Account {
  readonly accountId: string;
  readonly createdAt: number;
  readonly username: string;
}

/** What a successful login hands back. The refresh token is shown once and never again. */
interface TokenPair {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly refreshExpiresAt: number;
  readonly refreshToken: string;
  readonly sessionId: string;
}

/** A request carrying a valid token whose session is still live. */
interface Authenticated {
  readonly account: Account;
  readonly sessionId: string;
}

interface AuthStoreOptions extends AuthConfigInput {
  readonly dataDirectory: string;
  readonly database: Database;
  readonly logger?: Logger;
}

/**
 * A session row that may still authorize something: it exists, nobody ended it,
 * and it has not run out. Every path that accepts a token asks this same
 * question, so it is asked in one place.
 */
function isLive(row: SessionLifetime | undefined, now: number): row is SessionLifetime {
  return row?.revokedAt === null && row.expiresAt > now;
}

/** The columns `isLive` needs, whatever else a given query selected. */
interface SessionLifetime {
  readonly expiresAt: number;
  readonly revokedAt: null | number;
}

/** Thrown when registration is attempted on a Nox that already has its account. */
class AccountExistsError extends Error {
  constructor() {
    super('This Nox already has an account.');
    this.name = 'AccountExistsError';
  }
}

/**
 * The account this Nox belongs to, and the logins currently open on it.
 *
 * Single user is enforced in exactly one place — `register` refuses a second
 * account — and nowhere else. Everything below it already reads as though there
 * could be many, so lifting the restriction later is a change to that guard
 * rather than a migration.
 */
class AuthStore {
  readonly #config: AuthConfig;
  readonly #database: Database;
  readonly #logger: Logger;
  readonly #signingKey: Uint8Array;

  /**
   * Argon2 over a hash that matches nothing, so a wrong username costs the same
   * as a wrong password. Computed at most once, and only if someone ever gets
   * the username wrong.
   */
  #decoyHash?: Promise<string>;

  private constructor(
    config: AuthConfig,
    database: Database,
    logger: Logger,
    signingKey: Uint8Array,
  ) {
    this.#config = config;
    this.#database = database;
    this.#logger = logger;
    this.#signingKey = signingKey;
  }

  public static async open(options: AuthStoreOptions): Promise<AuthStore> {
    const config = parseOrThrow(authConfigSchema, {
      accessTtlSeconds: options.accessTtlSeconds,
      refreshTtlSeconds: options.refreshTtlSeconds,
      secureCookies: options.secureCookies,
    });
    const signingKey = await loadOrCreateSigningKey(options.dataDirectory);
    const store = new AuthStore(
      config,
      options.database,
      options.logger ?? silentLogger,
      signingKey,
    );

    await store.#purgeDeadSessions();
    return store;
  }

  /** The lifetimes and cookie policy this store was opened with, for the routes that apply them. */
  public get config(): AuthConfig {
    return this.#config;
  }

  /** Whether this Nox has been claimed yet. The install flow turns on this answer. */
  public async isRegistered(): Promise<boolean> {
    return this.#database.exclusive((database) =>
      Boolean(database.select({ accountId: accounts.accountId }).from(accounts).limit(1).get()),
    );
  }

  /**
   * Claims the installation. Hashing happens before the transaction because
   * Argon2 is deliberately slow and the write must not hold the database for as
   * long as it takes; the insert re-checks emptiness, so two registrations
   * racing still produce one account.
   */
  public async register(username: string, password: string): Promise<Account> {
    const passwordHash = await Bun.password.hash(password, PASSWORD_HASHING);
    const now = Date.now();

    const account = await this.#database.transaction((database) => {
      const existing = database
        .select({ accountId: accounts.accountId })
        .from(accounts)
        .limit(1)
        .get();
      if (existing !== undefined) throw new AccountExistsError();

      const row = { accountId: nanoid(), createdAt: now, passwordHash, updatedAt: now, username };
      database.insert(accounts).values(row).run();
      return { accountId: row.accountId, createdAt: row.createdAt, username: row.username };
    });

    this.#logger.info({ username }, 'Account registered.');
    return account;
  }

  /** The account, or undefined for both a wrong username and a wrong password. */
  public async authenticate(username: string, password: string): Promise<Account | undefined> {
    const row = await this.#database.exclusive((database) =>
      database.select().from(accounts).where(eq(accounts.username, username)).get(),
    );

    if (row === undefined) {
      await Bun.password.verify(password, await this.#decoy());
      return undefined;
    }
    if (!(await Bun.password.verify(password, row.passwordHash))) return undefined;

    return { accountId: row.accountId, createdAt: row.createdAt, username: row.username };
  }

  /** Opens a login: one row, one refresh token, one access token derived from both. */
  public async openSession(accountId: string): Promise<TokenPair> {
    const now = Date.now();
    const refresh = mintRefreshToken();
    const sessionId = nanoid();
    const expiresAt = now + this.#config.refreshTtlSeconds * 1000;

    await this.#database.exclusive((database) => {
      database
        .insert(authSessions)
        .values({
          accountId,
          createdAt: now,
          expiresAt,
          lastUsedAt: now,
          refreshTokenHash: refresh.hash,
          revokedAt: null,
          sessionId,
        })
        .run();
    });

    this.#logger.debug({ accountId, sessionId }, 'Auth session opened.');
    return this.#issue(sessionId, accountId, refresh.token, expiresAt);
  }

  /**
   * Trades a refresh token for a new pair, replacing the stored hash in the same
   * transaction that reads it. The old token stops working the instant the new
   * one exists, so two clients racing on the same token cannot both come away
   * with a session.
   */
  public async refresh(refreshToken: string): Promise<TokenPair | undefined> {
    const now = Date.now();
    const replacement = mintRefreshToken();

    const rotated = await this.#database.transaction((database) => {
      const row = database
        .select()
        .from(authSessions)
        .where(eq(authSessions.refreshTokenHash, hashRefreshToken(refreshToken)))
        .get();
      if (!isLive(row, now)) return undefined;

      const expiresAt = now + this.#config.refreshTtlSeconds * 1000;
      database
        .update(authSessions)
        .set({ expiresAt, lastUsedAt: now, refreshTokenHash: replacement.hash })
        .where(eq(authSessions.sessionId, row.sessionId))
        .run();

      return { accountId: row.accountId, expiresAt, sessionId: row.sessionId };
    });

    if (rotated === undefined) return undefined;
    return this.#issue(rotated.sessionId, rotated.accountId, replacement.token, rotated.expiresAt);
  }

  /**
   * The question the guard asks on every request. The signature says the token
   * was issued here and has not expired; the row says the login behind it is
   * still wanted. Both must hold — that second half is what makes a logout take
   * effect now rather than whenever the access token happens to run out.
   */
  public async resolve(accessToken: string): Promise<Authenticated | undefined> {
    const claims = await verifyAccessToken(accessToken, this.#signingKey);
    if (claims === undefined) return undefined;

    const now = Date.now();
    const row = await this.#database.exclusive((database) =>
      database
        .select({
          accountId: accounts.accountId,
          createdAt: accounts.createdAt,
          expiresAt: authSessions.expiresAt,
          revokedAt: authSessions.revokedAt,
          username: accounts.username,
        })
        .from(authSessions)
        .innerJoin(accounts, eq(accounts.accountId, authSessions.accountId))
        .where(eq(authSessions.sessionId, claims.sessionId))
        .get(),
    );

    if (!isLive(row, now)) return undefined;
    // A token signed for one account but naming another's session is not a
    // mismatch to reconcile; it is a forgery that happened to verify.
    if (row.accountId !== claims.accountId) return undefined;

    return {
      account: { accountId: row.accountId, createdAt: row.createdAt, username: row.username },
      sessionId: claims.sessionId,
    };
  }

  /**
   * Ends the login a refresh token belongs to, without issuing anything. What a
   * logout needs: the client proves which session is its own by presenting the
   * token, and gets no new one in exchange.
   */
  public async revokeByRefreshToken(refreshToken: string): Promise<boolean> {
    const now = Date.now();
    const revoked = await this.#database.transaction((database) => {
      const row = database
        .select({
          expiresAt: authSessions.expiresAt,
          revokedAt: authSessions.revokedAt,
          sessionId: authSessions.sessionId,
        })
        .from(authSessions)
        .where(eq(authSessions.refreshTokenHash, hashRefreshToken(refreshToken)))
        .get();
      if (!isLive(row, now)) return undefined;

      database
        .update(authSessions)
        .set({ revokedAt: now })
        .where(eq(authSessions.sessionId, row.sessionId))
        .run();
      return row.sessionId;
    });

    if (revoked !== undefined) this.#logger.debug({ sessionId: revoked }, 'Auth session revoked.');
    return revoked !== undefined;
  }

  /** Ends one login by id. Idempotent: revoking an already dead session is not a failure. */
  public async revoke(sessionId: string): Promise<boolean> {
    const now = Date.now();
    const revoked = await this.#database.transaction((database) => {
      const row = database
        .select({ expiresAt: authSessions.expiresAt, revokedAt: authSessions.revokedAt })
        .from(authSessions)
        .where(eq(authSessions.sessionId, sessionId))
        .get();
      if (!isLive(row, now)) return false;

      database
        .update(authSessions)
        .set({ revokedAt: now })
        .where(eq(authSessions.sessionId, sessionId))
        .run();
      return true;
    });

    if (revoked) this.#logger.debug({ sessionId }, 'Auth session revoked.');
    return revoked;
  }

  /** Signs the access half of a pair, which is the only part not written down. */
  async #issue(
    sessionId: string,
    accountId: string,
    refreshToken: string,
    refreshExpiresAt: number,
  ): Promise<TokenPair> {
    const claims: AccessClaims = { accountId, sessionId };
    return {
      accessToken: await signAccessToken(claims, this.#signingKey, this.#config.accessTtlSeconds),
      expiresInSeconds: this.#config.accessTtlSeconds,
      refreshExpiresAt,
      refreshToken,
      sessionId,
    };
  }

  /**
   * Rows that can never authorize anything again. Kept off the request path and
   * done once at startup: a login that ended is not worth a write during the
   * request that ended it, but it is worth not keeping forever.
   */
  async #purgeDeadSessions(): Promise<void> {
    const now = Date.now();
    const removed = await this.#database.exclusive((database) =>
      database
        .delete(authSessions)
        .where(or(lt(authSessions.expiresAt, now), isNotNull(authSessions.revokedAt)))
        .returning({ sessionId: authSessions.sessionId })
        .all(),
    );

    if (removed.length > 0) {
      this.#logger.debug({ count: removed.length }, 'Dead auth sessions purged.');
    }
  }

  #decoy(): Promise<string> {
    this.#decoyHash ??= Bun.password.hash(nanoid(), PASSWORD_HASHING);
    return this.#decoyHash;
  }
}

export { AccountExistsError, AuthStore };

export type { Account, Authenticated, AuthStoreOptions, TokenPair };
