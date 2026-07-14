import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { messageTable } from "./message";

/**
 * Individual tool call made by the assistant during a message turn.
 * Links back to the assistant message that produced the call.
 */
export const toolCallTable = sqliteTable("tool_call", {
  id: integer().primaryKey({ autoIncrement: true }),
  messageId: integer().notNull().references(() => messageTable.id, { onDelete: "cascade" }),
  trackId: text().notNull(),
  name: text().notNull(),
  arguments: text({ mode: "json" }),
  /** Whether the tool call resulted in an error */
  isError: integer({ mode: "boolean" }).default(false),
  /** JSON snapshot of the tool response */
  response: text({ mode: "json" }),
  /** Duration of the tool execution in ms */
  durationMs: integer(),
  createdAt: integer({ mode: "timestamp" }).notNull(),
});

export type ToolCall = typeof toolCallTable.$inferSelect;
export type NewToolCall = typeof toolCallTable.$inferInsert;
