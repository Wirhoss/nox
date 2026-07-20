import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { sessionTable } from './session';

import type { GatewayEvent } from '../../gateway/events';

export const sessionEventTable = sqliteTable('session_event', {
  id: integer().primaryKey({ autoIncrement: true }),
  sessionId: text().notNull().references(() => sessionTable.sessionId, { onDelete: 'cascade' }),
  type: text().notNull(),
  payload: text({ mode: 'json' }).$type<GatewayEvent>().notNull(),
  createdAt: integer({ mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`).notNull(),
}, (table) => [
  index('session_event_session_id_idx').on(table.sessionId, table.id),
]);

export type SessionEventRecord = typeof sessionEventTable.$inferSelect;
