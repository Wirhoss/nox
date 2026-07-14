import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { agentTable } from "../agent/agent";

/**
 * Session states:
 *  - idle      → session created, no run in progress
 *  - running   → agent is actively processing
 *  - completed → run finished successfully (no more tool calls)
 *  - error     → run ended with an error
 *  - aborted   → run was aborted by the user/system
 */
export const sessionTable = sqliteTable("session", {
  id: integer().primaryKey({ autoIncrement: true }),
  sessionId: text().notNull().unique(),
  agentId: integer().notNull().references(() => agentTable.id),
  title: text(),
  state: text({
    enum: ["idle", "running", "completed", "error", "aborted"],
  }).default("idle").notNull(),
  systemPrompt: text(),
  createdAt: integer({ mode: "timestamp" }).default(sql`(unixepoch())`).notNull(),
  updatedAt: integer({ mode: "timestamp" }).default(sql`(unixepoch())`).notNull(),
  completedAt: integer({ mode: "timestamp" }),
});

export type Session = typeof sessionTable.$inferSelect;
export type NewSession = typeof sessionTable.$inferInsert;
