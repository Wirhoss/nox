import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

import { sessionTable } from './session';

import type { Message } from '../../provider';

export const messageTable = sqliteTable('message', {
  id: integer().primaryKey({ autoIncrement: true }),
  sessionId: text().notNull().references(() => sessionTable.sessionId, { onDelete: 'cascade' }),
  position: integer().notNull(),
  role: text({ enum: ['user', 'assistant', 'reasoning', 'toolCall', 'toolResponse'] }).notNull(),
  execution: text({ enum: ['immediate', 'deferredAck', 'deferredResult'] }),
  payload: text({ mode: 'json' }).$type<Message>().notNull(),
  createdAt: integer({ mode: 'timestamp' }).default(sql`(unixepoch())`).notNull(),
}, (table) => [
  unique().on(table.sessionId, table.position),
]);

export type MessageRecord = typeof messageTable.$inferSelect;
export type NewMessageRecord = typeof messageTable.$inferInsert;
