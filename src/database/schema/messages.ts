import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import {
  MESSAGE_ROLES,
  type MessageContent,
  TOOL_RESPONSE_EXECUTIONS,
} from '../../context/message';
import { sessions } from './sessions';

const messages = sqliteTable(
  'messages',
  {
    anchorMessageId: text('anchor_message_id'),
    arguments: text('arguments', { mode: 'json' }).$type<Readonly<Record<string, unknown>>>(),
    content: text('content', { mode: 'json' }).$type<readonly MessageContent[]>(),
    createdAt: integer('created_at').notNull(),
    execution: text('execution', { enum: TOOL_RESPONSE_EXECUTIONS }),
    isError: integer('is_error', { mode: 'boolean' }),
    messageId: text('message_id').primaryKey(),
    name: text('name'),
    refMessageIds: text('ref_message_ids', { mode: 'json' }).$type<readonly string[]>(),
    role: text('role', { enum: MESSAGE_ROLES }).notNull(),
    seq: integer('seq').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    trackId: text('track_id'),
  },
  (table) => [
    uniqueIndex('messages_session_seq_idx').on(table.sessionId, table.seq),
    index('messages_track_idx').on(table.sessionId, table.trackId),
  ],
);

type MessageRow = typeof messages.$inferSelect;

type MessageRowInsert = typeof messages.$inferInsert;

export { messages };

export type { MessageRow, MessageRowInsert };
