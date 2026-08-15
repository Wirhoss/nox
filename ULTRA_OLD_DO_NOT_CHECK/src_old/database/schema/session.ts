import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const sessionTable = sqliteTable('session', {
  sessionId: text().primaryKey(),
  blueprintId: text().notNull(),
  systemPrompt: text().notNull(),
  createdAt: integer({ mode: 'timestamp' }).default(sql`(unixepoch())`).notNull(),
  updatedAt: integer({ mode: 'timestamp' }).default(sql`(unixepoch())`).notNull(),
});

export type SessionRecord = typeof sessionTable.$inferSelect;
export type NewSessionRecord = typeof sessionTable.$inferInsert;
