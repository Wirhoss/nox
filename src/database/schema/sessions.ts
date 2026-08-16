import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const sessions = sqliteTable('sessions', {
  createdAt: integer('created_at').notNull(),
  metadata: text('metadata', { mode: 'json' }).$type<Readonly<Record<string, unknown>>>(),
  sessionId: text('session_id').primaryKey(),
  title: text('title'),
  updatedAt: integer('updated_at').notNull(),
});

type SessionRow = typeof sessions.$inferSelect;

type SessionRowInsert = typeof sessions.$inferInsert;

export { sessions };

export type { SessionRow, SessionRowInsert };
