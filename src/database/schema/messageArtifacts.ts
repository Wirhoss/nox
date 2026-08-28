import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { messages } from './messages';
import { sessions } from './sessions';

/**
 * Which artifacts a transcript actually holds.
 *
 * The answer already exists inside `messages.content`, as `artifact` parts
 * buried in JSON, and it is the answer a permission check needs on every
 * `read_artifact` call — including for sessions that are not loaded. Scanning
 * every message to find out would make the cost of the check grow with the
 * history it is protecting, so the references are written out beside the
 * message that carried them.
 *
 * A row means "this transcript received this artifact", never "this artifact is
 * readable": the agent that owns the session is what turns one into the other.
 */
const messageArtifacts = sqliteTable(
  'message_artifacts',
  {
    artifactId: text('artifact_id').notNull(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.messageId, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.sessionId, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.artifactId] }),
    index('message_artifacts_artifact_idx').on(table.artifactId),
    index('message_artifacts_session_idx').on(table.sessionId),
  ],
);

type MessageArtifactRow = typeof messageArtifacts.$inferSelect;

type MessageArtifactRowInsert = typeof messageArtifacts.$inferInsert;

export { messageArtifacts };

export type { MessageArtifactRow, MessageArtifactRowInsert };
