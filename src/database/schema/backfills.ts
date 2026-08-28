import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Which one-time rebuilds have already run against this database.
 *
 * Derived indexes are built by this codebase's own functions, not by migration
 * SQL, so nothing in the migration journal records that they happened. Asking
 * the index itself — "is it empty?" — is not the same question: an index that is
 * legitimately empty, because no message ever carried an artifact, would be
 * rebuilt on every boot, and one built by an earlier release would be skipped
 * even though a later one needs a pass of its own.
 *
 * A row is that record, written in the same transaction as the rebuild it
 * describes. No row means the rebuild has not run.
 */
const backfills = sqliteTable('backfills', {
  completedAt: integer('completed_at').notNull(),
  name: text('name').primaryKey(),
});

type BackfillRow = typeof backfills.$inferSelect;

type BackfillRowInsert = typeof backfills.$inferInsert;

export { backfills };

export type { BackfillRow, BackfillRowInsert };
