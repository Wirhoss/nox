import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The people who may reach the HTTP surface. Nox is single user today and the
 * registration route enforces that, but the account is a row rather than a
 * setting so that stopping being single user is a change to one guard instead
 * of a change to storage.
 *
 * Passwords are hashed, never encrypted: unlike a provider key in `secrets`,
 * nothing here ever needs to be read back.
 */
const accounts = sqliteTable('accounts', {
  accountId: text('account_id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  passwordHash: text('password_hash').notNull(),
  updatedAt: integer('updated_at').notNull(),
  username: text('username').notNull().unique(),
});

type AccountRow = typeof accounts.$inferSelect;

type AccountRowInsert = typeof accounts.$inferInsert;

export { accounts };

export type { AccountRow, AccountRowInsert };
