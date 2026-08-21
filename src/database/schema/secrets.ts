import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Encrypted application-managed secrets. The key never enters SQLite; it lives
 * in the data directory as the store's local root of trust.
 */
const secrets = sqliteTable('secrets', {
  authTag: text('auth_tag').notNull(),
  ciphertext: text('ciphertext').notNull(),
  createdAt: integer('created_at').notNull(),
  nonce: text('nonce').notNull(),
  secretId: text('secret_id').primaryKey(),
  updatedAt: integer('updated_at').notNull(),
  version: integer('version').notNull(),
});

type SecretRow = typeof secrets.$inferSelect;

type SecretRowInsert = typeof secrets.$inferInsert;

export { secrets };

export type { SecretRow, SecretRowInsert };
