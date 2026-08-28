import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { sessions } from './sessions';

/**
 * One conversation on one transport, and the session that answers it. The key is
 * the pair the transport can name — a Discord channel, a WhatsApp chat — because
 * that is all a broker knows when a message arrives; the session id is Nox's
 * side of the binding, and it is what makes a chat survive a restart with its
 * transcript instead of starting over.
 */
const conversations = sqliteTable(
  'conversations',
  {
    agentId: text('agent_id').notNull(),
    brokerId: text('broker_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    createdAt: integer('created_at').notNull(),
    /** Conversation-local override; null means the agent's configured default. */
    modelId: text('model_id'),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.brokerId, table.conversationId] }),
    index('conversations_session_idx').on(table.sessionId),
  ],
);

type ConversationRow = typeof conversations.$inferSelect;
type ConversationRowInsert = typeof conversations.$inferInsert;

export { conversations };

export type { ConversationRow, ConversationRowInsert };
