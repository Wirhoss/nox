import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sessionTable } from "./session";

/**
 * A message exchanged in a session (user or assistant).
 * Content is stored as JSON to support the full MessageContent union type
 * (text, image, tool_call, tool_response).
 */
export const messageTable = sqliteTable("message", {
  id: integer().primaryKey({ autoIncrement: true }),
  sessionId: integer().notNull().references(() => sessionTable.id, { onDelete: "cascade" }),
  role: text({ enum: ["user", "assistant"] }).notNull(),
  content: text({ mode: "json" }).notNull(),
  /** Position of this message in the conversation */
  index: integer().notNull(),
  /** Tokens consumed/produced by this message turn */
  inputTokens: integer().default(0),
  outputTokens: integer().default(0),
  createdAt: integer({ mode: "timestamp" }).notNull(),
});

export type Message = typeof messageTable.$inferSelect;
export type NewMessage = typeof messageTable.$inferInsert;
