import { and, desc, eq } from 'drizzle-orm';

import { type ConversationRow, conversations, sessions } from './schema';

import type { Database } from './database';

/**
 * A binding as a transport asks for it, with the name of the session behind it.
 * The title lives on the session because that is what was named, and a list of
 * conversations is the one place it is read — so it is joined in here rather
 * than fetched one session at a time by whoever draws the list.
 */
interface ListedConversation extends ConversationRow {
  readonly title: null | string;
}

/** The pair a transport can name: which broker, and which chat on it. */
interface ConversationKey {
  readonly brokerId: string;
  readonly conversationId: string;
}

/**
 * Which session answers which conversation.
 *
 * This is the whole reason a chat survives a restart. Everything else the
 * gateway holds is live state that can be rebuilt; this binding cannot, because
 * nothing in a transport knows what a Nox session is. Reads and writes are both
 * awaited — a conversation is bound once and then read once per process, so
 * there is nothing here worth queueing.
 */
class ConversationStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  public async find(key: ConversationKey): Promise<ConversationRow | undefined> {
    return this.#database.exclusive((database) =>
      database
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.brokerId, key.brokerId),
            eq(conversations.conversationId, key.conversationId),
          ),
        )
        .get(),
    );
  }

  /**
   * Every conversation one transport carries, most recently spoken in first.
   * Scoped to a broker because that is the only scope a broker may ask about:
   * what another transport is carrying is not its to enumerate.
   */
  public async list(brokerId: string): Promise<ListedConversation[]> {
    return this.#database.exclusive((database) =>
      database
        .select({
          agentId: conversations.agentId,
          brokerId: conversations.brokerId,
          conversationId: conversations.conversationId,
          createdAt: conversations.createdAt,
          sessionId: conversations.sessionId,
          title: sessions.title,
          updatedAt: conversations.updatedAt,
        })
        .from(conversations)
        .leftJoin(sessions, eq(sessions.sessionId, conversations.sessionId))
        .where(eq(conversations.brokerId, brokerId))
        .orderBy(desc(conversations.updatedAt))
        .all(),
    );
  }

  /** Binds a conversation to a session. The pair is bound once and never moved. */
  public async bind(key: ConversationKey, agentId: string, sessionId: string): Promise<void> {
    const now = Date.now();
    await this.#database.exclusive((database) => {
      database
        .insert(conversations)
        .values({ ...key, agentId, createdAt: now, sessionId, updatedAt: now })
        .run();
    });
  }

  /** Records that the conversation was spoken in, so an idle one is recognisable. */
  public async touch(key: ConversationKey): Promise<void> {
    await this.#database.exclusive((database) => {
      database
        .update(conversations)
        .set({ updatedAt: Date.now() })
        .where(
          and(
            eq(conversations.brokerId, key.brokerId),
            eq(conversations.conversationId, key.conversationId),
          ),
        )
        .run();
    });
  }
}

export { ConversationStore };

export type { ConversationKey, ListedConversation };
