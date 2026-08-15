import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const deepResearchStatuses = ['draft', 'active', 'paused', 'completed', 'failed', 'cancelled'] as const;

export const deepResearchTable = sqliteTable('deep_research', {
  researchId: text().primaryKey(),
  title: text().notNull(),
  objective: text().notNull(),
  status: text({ enum: deepResearchStatuses }).default('draft').notNull(),
  createdAt: integer({ mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`).notNull(),
  updatedAt: integer({ mode: 'timestamp_ms' }).default(sql`(unixepoch() * 1000)`).notNull(),
}, (table) => [
  index('deep_research_status_updated_idx').on(table.status, table.updatedAt),
]);

export type DeepResearchRecord = typeof deepResearchTable.$inferSelect;
export type NewDeepResearchRecord = typeof deepResearchTable.$inferInsert;
export type DeepResearchStatus = typeof deepResearchStatuses[number];

export {
  deepResearchStatuses,
};
