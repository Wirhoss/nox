import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agentTable = sqliteTable("agent", {
  id: integer().primaryKey({ autoIncrement: true }),
  agentId: text().notNull(),
});