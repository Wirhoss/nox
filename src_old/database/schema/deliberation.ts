import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const deliberationStatuses = ['draft', 'active', 'paused', 'completed', 'failed', 'cancelled'] as const;
const deliberationTerminationReasons = ['consensus', 'max_rounds'] as const;
const deliberationTurnPhases = ['proposal', 'critique', 'consensus', 'synthesis'] as const;

export const deliberationTable = sqliteTable('deliberation', {
  deliberationId: text().primaryKey(),
  title: text().notNull(),
  question: text().notNull(),
  participantBlueprintIds: text({ mode: 'json' }).$type<string[]>().default(sql`'[]'`).notNull(),
  moderatorBlueprintId: text(),
  rounds: integer().default(2).notNull(),
  currentRound: integer().default(0).notNull(),
  status: text({ enum: deliberationStatuses }).default('draft').notNull(),
  consensusReached: integer({ mode: 'boolean' }).default(false).notNull(),
  terminationReason: text({ enum: deliberationTerminationReasons }),
  finalReport: text(),
  error: text(),
  startedAt: integer({ mode: 'timestamp_ms' }),
  completedAt: integer({ mode: 'timestamp_ms' }),
  createdAt: integer({ mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`).notNull(),
  updatedAt: integer({ mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`).notNull(),
}, (table) => [
  index('deliberation_status_updated_idx').on(table.status, table.updatedAt),
]);

export const deliberationTurnTable = sqliteTable('deliberation_turn', {
  turnId: integer().primaryKey({ autoIncrement: true }),
  deliberationId: text().notNull().references(() => deliberationTable.deliberationId, { onDelete: 'cascade' }),
  round: integer().notNull(),
  phase: text({ enum: deliberationTurnPhases }).notNull(),
  blueprintId: text().notNull(),
  sessionId: text().notNull(),
  content: text().notNull(),
  createdAt: integer({ mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`).notNull(),
}, (table) => [
  index('deliberation_turn_deliberation_idx').on(table.deliberationId, table.turnId),
]);

export type DeliberationRecord = typeof deliberationTable.$inferSelect;
export type NewDeliberationRecord = typeof deliberationTable.$inferInsert;
export type DeliberationStatus = typeof deliberationStatuses[number];
export type DeliberationTerminationReason = typeof deliberationTerminationReasons[number];
export type DeliberationTurnRecord = typeof deliberationTurnTable.$inferSelect;
export type NewDeliberationTurnRecord = typeof deliberationTurnTable.$inferInsert;
export type DeliberationTurnPhase = typeof deliberationTurnPhases[number];

export {
  deliberationStatuses,
  deliberationTerminationReasons,
  deliberationTurnPhases,
};
