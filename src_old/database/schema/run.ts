import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { sessionTable } from './session';

const runStatuses = ['running', 'completed', 'aborted', 'maxIterations', 'failed'] as const;

export const runTable = sqliteTable('run', {
  runId: text().primaryKey(),
  sessionId: text().notNull().references(() => sessionTable.sessionId, { onDelete: 'cascade' }),
  modelId: text(),
  status: text({ enum: runStatuses }).notNull(),
  startedAt: integer({ mode: 'timestamp_ms' }).notNull(),
  completedAt: integer({ mode: 'timestamp_ms' }),
  durationMs: integer(),
  inputTokens: integer().default(0).notNull(),
  outputTokens: integer().default(0).notNull(),
  cacheReadTokens: integer().default(0).notNull(),
}, (table) => [
  index('run_session_started_idx').on(table.sessionId, table.startedAt),
]);

export type RunRecord = typeof runTable.$inferSelect;
export type NewRunRecord = typeof runTable.$inferInsert;
export type RunStatus = typeof runStatuses[number];
