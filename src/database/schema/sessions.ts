import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const sessions = sqliteTable('sessions', {
  /**
   * Which agent the conversation was held with. Nullable only because sessions
   * stored before attribution existed genuinely have no answer; everything
   * opened through an `Agent` writes it.
   */
  agentId: text('agent_id'),
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
