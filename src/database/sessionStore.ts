import { asc, eq } from 'drizzle-orm';

import { type Logger, silentLogger } from '../logger/logger';
import {
  type GateDecisionRow,
  type GateDecisionRowInsert,
  gateDecisions,
  type MessageRow,
  type MessageRowInsert,
  messages,
  type SessionRow,
  sessions,
} from './schema';

import type { Message } from '../agent/context/message';
import type { GateAuditRecord, PermissionResolution } from '../tool/gate';
import type { Database, NoxDrizzle } from './database';

interface SessionStoreOptions {
  logger?: Logger;
  /** Called when a queued write fails, so a session can surface it as an event. */
  onError?: (error: Error, sessionId: string) => void;
}

interface CreateSessionOptions {
  metadata?: Readonly<Record<string, unknown>>;
  title?: string;
}

interface StoredSession {
  messages: Message[];
  session: SessionRow;
}

function gateDecisionToRow(record: GateAuditRecord): GateDecisionRowInsert {
  return {
    createdAt: record.createdAt.getTime(),
    decidedBy: record.decidedBy,
    decisionId: record.decisionId,
    params: record.params,
    preview: record.preview,
    reason: record.reason,
    resolution: record.resolution,
    resolvedAt: record.resolvedAt?.getTime(),
    risk: record.risk,
    scope: record.scope,
    sessionId: record.sessionId,
    signals: record.signals,
    title: record.title,
    toolName: record.toolName,
    toolSetId: record.toolSetId,
    trackId: record.trackId,
    verdict: record.verdict,
  };
}

function gateDecisionToRecord(row: GateDecisionRow): GateAuditRecord {
  return {
    createdAt: new Date(row.createdAt),
    decidedBy: row.decidedBy,
    decisionId: row.decisionId,
    params: row.params,
    preview: row.preview ?? undefined,
    reason: row.reason,
    resolution: row.resolution ?? undefined,
    resolvedAt: row.resolvedAt === null ? undefined : new Date(row.resolvedAt),
    risk: row.risk ?? undefined,
    scope: row.scope ?? undefined,
    sessionId: row.sessionId,
    signals: row.signals,
    title: row.title,
    toolName: row.toolName,
    toolSetId: row.toolSetId,
    trackId: row.trackId,
    verdict: row.verdict,
  };
}

function fail(row: MessageRow, missing: string): never {
  throw new Error(
    `Message ${row.messageId} in session ${row.sessionId} is not a valid ${row.role}: ` +
      `${missing} is missing.`,
  );
}

function toRow(sessionId: string, seq: number, message: Message): MessageRowInsert {
  const base = {
    createdAt: message.createdAt.getTime(),
    messageId: message.messageId,
    seq,
    sessionId,
  };

  switch (message.role) {
    case 'assistant':
    case 'reasoning':
    case 'user':
      return { ...base, content: message.content, role: message.role };
    case 'compacted':
      return {
        ...base,
        content: message.content,
        refMessageIds: message.compactedMessageIds,
        role: 'compacted',
      };
    case 'folded':
      return {
        ...base,
        anchorMessageId: message.anchorMessageId,
        content: message.content,
        refMessageIds: message.foldedMessageIds,
        role: 'folded',
      };
    case 'toolCall':
      return {
        ...base,
        arguments: message.arguments,
        name: message.name,
        role: 'toolCall',
        trackId: message.trackId,
      };
    case 'toolResponse':
      return {
        ...base,
        content: message.response,
        execution: message.execution,
        isError: message.isError ?? false,
        name: message.name,
        role: 'toolResponse',
        trackId: message.trackId,
      };
  }
}

/**
 * Rebuilds one message, or refuses to. A row that cannot become a message means
 * the stored history is not the history that happened, and replaying a damaged
 * transcript is worse than not opening the session.
 */
function toMessage(row: MessageRow): Message {
  const createdAt = new Date(row.createdAt);
  const { messageId } = row;

  switch (row.role) {
    case 'assistant':
      return { content: row.content ?? fail(row, 'content'), createdAt, messageId, role: row.role };
    case 'reasoning':
      return { content: row.content ?? fail(row, 'content'), createdAt, messageId, role: row.role };
    case 'user':
      return { content: row.content ?? fail(row, 'content'), createdAt, messageId, role: row.role };
    case 'compacted':
      return {
        compactedMessageIds: row.refMessageIds ?? fail(row, 'refMessageIds'),
        content: row.content ?? fail(row, 'content'),
        createdAt,
        messageId,
        role: row.role,
      };
    case 'folded':
      return {
        anchorMessageId: row.anchorMessageId ?? fail(row, 'anchorMessageId'),
        content: row.content ?? fail(row, 'content'),
        createdAt,
        foldedMessageIds: row.refMessageIds ?? fail(row, 'refMessageIds'),
        messageId,
        role: row.role,
      };
    case 'toolCall':
      return {
        arguments: row.arguments ?? fail(row, 'arguments'),
        createdAt,
        messageId,
        name: row.name ?? fail(row, 'name'),
        role: row.role,
        trackId: row.trackId ?? fail(row, 'trackId'),
      };
    case 'toolResponse':
      return {
        createdAt,
        execution: row.execution ?? fail(row, 'execution'),
        isError: row.isError ?? false,
        messageId,
        name: row.name ?? fail(row, 'name'),
        response: row.content ?? fail(row, 'content'),
        role: row.role,
        trackId: row.trackId ?? fail(row, 'trackId'),
      };
  }
}

/**
 * Storage for sessions and their transcripts.
 *
 * `append` is the half that matters: it is synchronous because the transcript
 * hands it every message the moment it lands, and appending is not allowed to
 * block or fail. The row is built and sequenced right there, and the write
 * itself is queued — ordered per session, serialized against every other writer
 * by the database's own write queue.
 */
class SessionStore {
  readonly #database: Database;
  readonly #logger: Logger;
  readonly #nextSeq = new Map<string, number>();
  readonly #onError?: (error: Error, sessionId: string) => void;

  #writes: Promise<void> = Promise.resolve();

  constructor(database: Database, options: SessionStoreOptions = {}) {
    this.#database = database;
    this.#logger = options.logger ?? silentLogger;
    this.#onError = options.onError;
  }

  /** Resolves once every queued write has settled. */
  public get flushed(): Promise<void> {
    return this.#writes;
  }

  /** Queues one message. Returns as soon as it is sequenced, not when written. */
  public append(sessionId: string, message: Message): void {
    const seq = this.#nextSeq.get(sessionId) ?? 0;
    this.#nextSeq.set(sessionId, seq + 1);
    const row = toRow(sessionId, seq, message);

    this.#enqueue(sessionId, (database) => {
      database.transaction((tx) => {
        tx.insert(messages).values(row).run();
        tx.update(sessions)
          .set({ updatedAt: Date.now() })
          .where(eq(sessions.sessionId, sessionId))
          .run();
      });
    });
  }

  public recordGateDecision(record: GateAuditRecord): void {
    const row = gateDecisionToRow(record);
    this.#enqueue(record.sessionId, (database) => {
      database.insert(gateDecisions).values(row).run();
    });
  }

  public resolveGateDecision(
    sessionId: string,
    decisionId: string,
    resolution: PermissionResolution,
    resolvedAt: Date,
  ): void {
    this.#enqueue(sessionId, (database) => {
      database
        .update(gateDecisions)
        .set({
          resolution: resolution.resolution,
          resolvedAt: resolvedAt.getTime(),
          scope: resolution.resolution === 'approved' ? resolution.scope : null,
        })
        .where(eq(gateDecisions.decisionId, decisionId))
        .run();
    });
  }

  public async loadGateDecisions(sessionId: string): Promise<GateAuditRecord[]> {
    await this.#writes;
    return this.#database.exclusive((database) =>
      database
        .select()
        .from(gateDecisions)
        .where(eq(gateDecisions.sessionId, sessionId))
        .orderBy(asc(gateDecisions.createdAt))
        .all()
        .map(gateDecisionToRecord),
    );
  }

  public async create(sessionId: string, options: CreateSessionOptions = {}): Promise<SessionRow> {
    const now = Date.now();
    const row: SessionRow = {
      createdAt: now,
      metadata: options.metadata ?? null,
      sessionId,
      title: options.title ?? null,
      updatedAt: now,
    };

    await this.#database.exclusive((database) => {
      database.insert(sessions).values(row).run();
    });
    this.#nextSeq.set(sessionId, 0);
    return row;
  }

  /** The session and its full transcript, in append order. */
  public async load(sessionId: string): Promise<StoredSession | undefined> {
    const stored = await this.#database.exclusive((database) => {
      const session = database
        .select()
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .get();
      if (session === undefined) return undefined;

      const rows = database
        .select()
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(asc(messages.seq))
        .all();
      return { rows, session };
    });

    if (stored === undefined) return undefined;

    const lastSeq = stored.rows.at(-1)?.seq;
    this.#nextSeq.set(sessionId, lastSeq === undefined ? 0 : lastSeq + 1);
    return { messages: stored.rows.map(toMessage), session: stored.session };
  }

  #enqueue(sessionId: string, write: (database: NoxDrizzle) => void): void {
    this.#writes = this.#writes.then(async () => {
      try {
        await this.#database.exclusive(write);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        // The in-memory transcript is still correct; what is lost is durability,
        // and a session that loses it silently is one you find out about on the
        // next open.
        this.#logger.error({ err: failure, sessionId }, 'Failed to persist a message.');
        this.#onError?.(failure, sessionId);
      }
    });
  }
}

export { gateDecisionToRecord, gateDecisionToRow, SessionStore, toMessage, toRow };

export type { CreateSessionOptions, SessionStoreOptions, StoredSession };
