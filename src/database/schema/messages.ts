import { TOOL_OUTPUT_TRUST, TOOL_RESPONSE_EXECUTIONS } from '@nox/extension-api';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { MESSAGE_ROLES } from '../../agent/context/message';
import { sessions } from './sessions';

import type { MessageContent } from '@nox/extension-api';

const messages = sqliteTable(
  'messages',
  {
    arguments: text('arguments', { mode: 'json' }).$type<Readonly<Record<string, unknown>>>(),
    content: text('content', { mode: 'json' }).$type<readonly MessageContent[]>(),
    createdAt: integer('created_at').notNull(),
    /** How a user message entered the run; null only for old rows and non-user roles. */
    delivery: text('delivery', { enum: ['message', 'observation', 'steer'] }),
    execution: text('execution', { enum: TOOL_RESPONSE_EXECUTIONS }),
    isError: integer('is_error', { mode: 'boolean' }),
    messageId: text('message_id').primaryKey(),
    name: text('name'),
    /**
     * Who said it, for user messages. Nullable because most roles have no
     * author at all — an assistant reply and a tool response are not anyone's
     * message. A `user` row missing it is refused on read rather than loaded as
     * an unattributed one.
     */
    principalIssuer: text('principal_issuer'),
    principalSubject: text('principal_subject'),
    refMessageIds: text('ref_message_ids', { mode: 'json' }).$type<readonly string[]>(),
    role: text('role', { enum: MESSAGE_ROLES }).notNull(),
    seq: integer('seq').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    trackId: text('track_id'),
    /** The transport's own ID for the message the principal sent. */
    transportMessageId: text('transport_message_id'),
    /** Whose writing a tool response is. Null for message roles that do not use it. */
    trust: text('trust', { enum: TOOL_OUTPUT_TRUST }),
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
