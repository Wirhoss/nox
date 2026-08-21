import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { accounts } from './accounts';

/**
 * One row per login, and the reason access tokens are worth storing at all: the
 * signed token proves who asked, this row decides whether they still may. A
 * logout stamps `revokedAt` in the same request that answers it, so a stolen
 * access token stops working immediately instead of at its own expiry.
 *
 * Only the hash of the refresh token is kept. A reader of this table — a backup,
 * a stray copy of the database file — learns that a session exists, never how to
 * resume it. Rotation replaces the hash on every refresh, which is what turns a
 * replayed refresh token into a detectable event rather than a second session.
 *
 * Unrelated to the `sessions` table, which holds agent conversations.
 */
const authSessions = sqliteTable(
  'auth_sessions',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
    /** When the refresh token stops being accepted; the access token expires far sooner. */
    expiresAt: integer('expires_at').notNull(),
    lastUsedAt: integer('last_used_at').notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull().unique(),
    /** Null while the session is live. Set once, by a logout or a revocation. */
    revokedAt: integer('revoked_at'),
    sessionId: text('session_id').primaryKey(),
  },
  (table) => [
    index('auth_sessions_account_idx').on(table.accountId),
    index('auth_sessions_expires_idx').on(table.expiresAt),
  ],
);

type AuthSessionRow = typeof authSessions.$inferSelect;

type AuthSessionRowInsert = typeof authSessions.$inferInsert;

export { authSessions };

export type { AuthSessionRow, AuthSessionRowInsert };
