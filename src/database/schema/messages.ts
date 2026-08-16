import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { sessions } from "./sessions";

import type { MessageContent, ToolResponseExecution } from "../../agent/context/message";

const MESSAGE_ROLES = [
  "assistant",
  "compacted",
  "folded",
  "reasoning",
  "toolCall",
  "toolResponse",
  "user",
] as const;

const TOOL_RESPONSE_EXECUTIONS = [
  "deferredAck",
  "deferredResult",
  "immediate",
] as const satisfies readonly ToolResponseExecution[];

/**
 * One row per `Message`. The seven variants of the union share a table because
 * they are always read back as one ordered transcript; `role` is the
 * discriminator and the variant-specific columns are nullable.
 *
 * | column              | roles that populate it                                          |
 * | ------------------- | --------------------------------------------------------------- |
 * | `content`           | every role except `toolCall`                                      |
 * | `name` / `track_id` | `toolCall`, `toolResponse`                                        |
 * | `arguments`         | `toolCall`                                                        |
 * | `execution`         | `toolResponse`                                                    |
 * | `is_error`          | `toolResponse`                                                    |
 * | `anchor_message_id` | `folded`                                                          |
 * | `ref_message_ids`   | `compacted` (compactedMessageIds), `folded` (foldedMessageIds)     |
 */
const messages = sqliteTable(
  "messages",
  {
    anchorMessageId: text("anchor_message_id"),
    arguments: text("arguments", { mode: "json" }).$type<Readonly<Record<string, unknown>>>(),
    content: text("content", { mode: "json" }).$type<readonly MessageContent[]>(),
    createdAt: integer("created_at").notNull(),
    execution: text("execution", { enum: TOOL_RESPONSE_EXECUTIONS }),
    isError: integer("is_error", { mode: "boolean" }),
    messageId: text("message_id").primaryKey(),
    name: text("name"),
    refMessageIds: text("ref_message_ids", { mode: "json" }).$type<readonly string[]>(),
    role: text("role", { enum: MESSAGE_ROLES }).notNull(),
    // Monotonic per session: transcript order, independent of clock skew.
    seq: integer("seq").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.sessionId, { onDelete: "cascade" }),
    trackId: text("track_id"),
  },
  (table) => [
    uniqueIndex("messages_session_seq_idx").on(table.sessionId, table.seq),
    index("messages_track_idx").on(table.sessionId, table.trackId),
  ],
);

type MessageRow = typeof messages.$inferSelect;

type MessageRowInsert = typeof messages.$inferInsert;

export { MESSAGE_ROLES, messages, TOOL_RESPONSE_EXECUTIONS };

export type { MessageRow, MessageRowInsert };
