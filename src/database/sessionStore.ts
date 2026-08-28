import { and, asc, count, countDistinct, desc, eq, inArray, isNull, max } from 'drizzle-orm';

import { type Logger, silentLogger } from '../logger/logger';
import {
  type DecisionRow,
  type DecisionRowInsert,
  decisions,
  type MessageRow,
  type MessageRowInsert,
  messages,
  type SessionRow,
  sessions,
} from './schema';

import type { AuthorizationAuditRecord, StoredDecision } from '../auth/audit';
import type { GateAuditRecord, PermissionResolution } from '../tool/gate';
import type { Database, NoxDrizzle } from './database';
import type {
  Message,
  MessageContent,
  PrincipalRef,
  ToolOutputTrust,
  ToolResponseExecution,
} from '@nox/extension-api';

interface SessionStoreOptions {
  logger?: Logger;
  /** Called when a queued write fails, so a session can surface it as an event. */
  onError?: (error: Error, sessionId: string) => void;
}

interface CreateSessionOptions {
  /** The agent the session is being held with, recorded so it stays known. */
  agentId?: string;
  metadata?: Readonly<Record<string, unknown>>;
  title?: string;
}

interface StoredSession {
  messages: Message[];
  session: SessionRow;
}

interface AuditToolResponse {
  readonly content: readonly MessageContent[];
  readonly createdAt: Date;
  readonly execution: ToolResponseExecution;
  readonly isError: boolean;
  readonly trust: ToolOutputTrust;
}

interface SessionAgentSummary {
  readonly agentId?: string;
  readonly lastSessionAt: Date;
  readonly sessionCount: number;
}

interface SessionSummary {
  readonly agentId?: string;
  readonly createdAt: Date;
  readonly sessionId: string;
  readonly title?: string;
  readonly updatedAt: Date;
}

interface SessionList {
  readonly entries: readonly SessionSummary[];
  readonly limit: number;
  readonly offset: number;
  readonly total: number;
}

interface AuditAction {
  readonly authority: string;
  readonly createdAt: Date;
  readonly decisions: readonly StoredDecision[];
  readonly responses: readonly AuditToolResponse[];
  readonly runId: string;
  readonly sessionId: string;
  readonly title?: string;
  readonly toolName: string;
  readonly toolSetId: string;
  readonly trackId: string;
}

interface AuditActionList {
  readonly entries: readonly AuditAction[];
  readonly limit: number;
  readonly offset: number;
  readonly total: number;
}

function authorizationToRow(record: AuthorizationAuditRecord): DecisionRowInsert {
  return {
    authority: record.authority,
    createdAt: record.createdAt.getTime(),
    decidedBy: record.decidedBy,
    decisionId: record.decisionId,
    matchedGrant: record.matchedGrant,
    params: record.params,
    principalIssuer: record.principal.issuer,
    principalSubject: record.principal.subject,
    reason: record.reason,
    runId: record.runId,
    sessionId: record.sessionId,
    stage: 'authorization',
    toolName: record.toolName,
    toolSetId: record.toolSetId,
    trackId: record.trackId,
    verdict: record.verdict,
  };
}

function gateDecisionToRow(record: GateAuditRecord): DecisionRowInsert {
  return {
    authority: record.authority,
    createdAt: record.createdAt.getTime(),
    decidedBy: record.decidedBy,
    decisionId: record.decisionId,
    params: record.params,
    preview: record.preview,
    principalIssuer: record.runAuthority.principal.issuer,
    principalSubject: record.runAuthority.principal.subject,
    reason: record.reason,
    resolution: record.resolution,
    resolvedAt: record.resolvedAt?.getTime(),
    resolvedByIssuer: record.resolvedBy?.issuer,
    resolvedBySubject: record.resolvedBy?.subject,
    risk: record.risk,
    runId: record.runId,
    scope: record.scope,
    sessionId: record.sessionId,
    signals: record.signals,
    stage: 'gate',
    title: record.title,
    toolName: record.toolName,
    toolSetId: record.toolSetId,
    trackId: record.trackId,
    verdict: record.verdict,
  };
}

function decisionToRecord(row: DecisionRow): StoredDecision {
  const resolvedBy =
    row.resolvedByIssuer === null || row.resolvedBySubject === null
      ? undefined
      : { issuer: row.resolvedByIssuer, subject: row.resolvedBySubject };

  return {
    authority: row.authority,
    createdAt: new Date(row.createdAt),
    decidedBy: row.decidedBy,
    decisionId: row.decisionId,
    matchedGrant: row.matchedGrant ?? undefined,
    params: row.params,
    preview: row.preview ?? undefined,
    principal: { issuer: row.principalIssuer, subject: row.principalSubject },
    reason: row.reason,
    resolution: row.resolution ?? undefined,
    resolvedAt: row.resolvedAt === null ? undefined : new Date(row.resolvedAt),
    resolvedBy,
    risk: row.risk ?? undefined,
    runId: row.runId,
    scope: row.scope ?? undefined,
    sessionId: row.sessionId,
    signals: row.signals ?? undefined,
    stage: row.stage,
    title: row.title ?? undefined,
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
      return { ...base, content: message.content, role: message.role };
    case 'user':
      return {
        ...base,
        content: message.content,
        ...(message.delivery === undefined ? {} : { delivery: message.delivery }),
        principalIssuer: message.origin.principal.issuer,
        principalSubject: message.origin.principal.subject,
        role: 'user',
        transportMessageId: message.origin.transportMessageId,
      };
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
        trust: message.trust,
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
      return {
        content: row.content ?? fail(row, 'content'),
        createdAt,
        ...(row.delivery === null ? {} : { delivery: row.delivery }),
        messageId,
        origin: {
          principal: {
            issuer: row.principalIssuer ?? fail(row, 'principalIssuer'),
            subject: row.principalSubject ?? fail(row, 'principalSubject'),
          },
          transportMessageId: row.transportMessageId ?? fail(row, 'transportMessageId'),
        },
        role: row.role,
      };
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
        trust: row.trust ?? fail(row, 'trust'),
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

  /**
   * An authorization decision, allow or deny alike. A deny never reaches the
   * Gate, so without this the attempt would leave no trace anywhere.
   */
  public recordAuthorizationDecision(record: AuthorizationAuditRecord): void {
    const row = authorizationToRow(record);
    this.#enqueue(record.sessionId, (database) => {
      database.insert(decisions).values(row).run();
    });
  }

  public recordGateDecision(record: GateAuditRecord): void {
    const row = gateDecisionToRow(record);
    this.#enqueue(record.sessionId, (database) => {
      database.insert(decisions).values(row).run();
    });
  }

  public resolveGateDecision(
    sessionId: string,
    decisionId: string,
    resolution: PermissionResolution,
    resolvedAt: Date,
    resolvedBy?: PrincipalRef,
  ): void {
    this.#enqueue(sessionId, (database) => {
      database
        .update(decisions)
        .set({
          resolution: resolution.resolution,
          resolvedAt: resolvedAt.getTime(),
          resolvedByIssuer: resolvedBy?.issuer ?? null,
          resolvedBySubject: resolvedBy?.subject ?? null,
          scope: resolution.resolution === 'approved' ? resolution.scope : null,
        })
        .where(eq(decisions.decisionId, decisionId))
        .run();
    });
  }

  /**
   * Closures behind pending approvals cannot survive a process restart. Resuming
   * their session therefore closes every unresolved escalation before any stale
   * transport answer can make it look live again.
   */
  public async abortUnresolvedGateDecisions(
    sessionId: string,
    resolvedAt = new Date(),
  ): Promise<void> {
    await this.#writes;
    await this.#database.exclusive((database) => {
      database
        .update(decisions)
        .set({ resolution: 'aborted', resolvedAt: resolvedAt.getTime() })
        .where(
          and(
            eq(decisions.sessionId, sessionId),
            eq(decisions.stage, 'gate'),
            eq(decisions.verdict, 'escalate'),
            isNull(decisions.resolution),
          ),
        )
        .run();
    });
  }

  /** Both halves of the pipeline, oldest first: one timeline for one session. */
  public async loadDecisions(sessionId: string): Promise<StoredDecision[]> {
    await this.#writes;
    return this.#database.exclusive((database) =>
      database
        .select()
        .from(decisions)
        .where(eq(decisions.sessionId, sessionId))
        .orderBy(asc(decisions.createdAt))
        .all()
        .map(decisionToRecord),
    );
  }

  /** Historical agents derived from sessions, including removed configurations. */
  public async listSessionAgents(): Promise<readonly SessionAgentSummary[]> {
    await this.#writes;
    return this.#database.exclusive((database) =>
      database
        .select({
          agentId: sessions.agentId,
          lastSessionAt: max(sessions.updatedAt),
          sessionCount: count(),
        })
        .from(sessions)
        .groupBy(sessions.agentId)
        .orderBy(desc(max(sessions.updatedAt)))
        .all()
        .map((row): SessionAgentSummary => {
          if (row.lastSessionAt === null) throw new Error('A session agent has no sessions.');
          return {
            ...(row.agentId === null ? {} : { agentId: row.agentId }),
            lastSessionAt: new Date(row.lastSessionAt),
            sessionCount: row.sessionCount,
          };
        }),
    );
  }

  /** Sessions belonging to exactly one historical agent, newest first. */
  public async listSessions(agentId: null | string, limit = 50, offset = 0): Promise<SessionList> {
    await this.#writes;
    return this.#database.exclusive((database) => {
      const where = agentId === null ? isNull(sessions.agentId) : eq(sessions.agentId, agentId);
      const total =
        database.select({ value: count() }).from(sessions).where(where).get()?.value ?? 0;
      const entries = database
        .select()
        .from(sessions)
        .where(where)
        .orderBy(desc(sessions.updatedAt), desc(sessions.sessionId))
        .limit(limit)
        .offset(offset)
        .all()
        .map((row): SessionSummary => ({
          ...(row.agentId === null ? {} : { agentId: row.agentId }),
          createdAt: new Date(row.createdAt),
          sessionId: row.sessionId,
          ...(row.title === null ? {} : { title: row.title }),
          updatedAt: new Date(row.updatedAt),
        }));
      return { entries, limit, offset, total };
    });
  }

  /** One row per tool action, with authorization and Gate decisions kept together. */
  public async listAuditActions(
    sessionId: string,
    limit = 50,
    offset = 0,
  ): Promise<AuditActionList> {
    await this.#writes;
    return this.#database.exclusive((database) => {
      const where = eq(decisions.sessionId, sessionId);
      const total =
        database
          .select({ value: countDistinct(decisions.trackId) })
          .from(decisions)
          .where(where)
          .get()?.value ?? 0;
      const tracks = database
        .select({ createdAt: max(decisions.createdAt), trackId: decisions.trackId })
        .from(decisions)
        .where(where)
        .groupBy(decisions.trackId)
        .orderBy(desc(max(decisions.createdAt)), desc(decisions.trackId))
        .limit(limit)
        .offset(offset)
        .all();
      if (tracks.length === 0) return { entries: [], limit, offset, total };

      const trackIds = tracks.map((track) => track.trackId);
      const records = database
        .select()
        .from(decisions)
        .where(and(where, inArray(decisions.trackId, trackIds)))
        .orderBy(asc(decisions.createdAt), asc(decisions.decisionId))
        .all();
      const grouped = new Map<string, StoredDecision[]>();
      for (const row of records) {
        const entries = grouped.get(row.trackId) ?? [];
        entries.push(decisionToRecord(row));
        grouped.set(row.trackId, entries);
      }

      const responseGroups = new Map<string, AuditToolResponse[]>();
      const responses = database
        .select({
          content: messages.content,
          createdAt: messages.createdAt,
          execution: messages.execution,
          isError: messages.isError,
          trackId: messages.trackId,
          trust: messages.trust,
        })
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, sessionId),
            eq(messages.role, 'toolResponse'),
            inArray(messages.trackId, trackIds),
          ),
        )
        .orderBy(asc(messages.seq))
        .all();
      for (const response of responses) {
        if (response.execution === null || response.trackId === null) continue;
        if (response.content === null || response.trust === null) {
          throw new Error(`Audit response for ${response.trackId} is incomplete.`);
        }
        const groupedResponses = responseGroups.get(response.trackId) ?? [];
        groupedResponses.push({
          content: response.content,
          createdAt: new Date(response.createdAt),
          execution: response.execution,
          isError: response.isError ?? false,
          trust: response.trust,
        });
        responseGroups.set(response.trackId, groupedResponses);
      }

      const entries = tracks.map((track): AuditAction => {
        const actionDecisions = grouped.get(track.trackId) ?? [];
        const subject =
          actionDecisions.findLast((decision) => decision.stage === 'gate') ??
          actionDecisions.at(-1);
        if (subject === undefined || track.createdAt === null) {
          throw new Error(`Audit action ${track.trackId} has no decisions.`);
        }
        return {
          authority: subject.authority,
          createdAt: new Date(track.createdAt),
          decisions: actionDecisions,
          responses: responseGroups.get(track.trackId) ?? [],
          runId: subject.runId,
          sessionId,
          ...(subject.title === undefined ? {} : { title: subject.title }),
          toolName: subject.toolName,
          toolSetId: subject.toolSetId,
          trackId: track.trackId,
        };
      });
      return { entries, limit, offset, total };
    });
  }

  public async create(sessionId: string, options: CreateSessionOptions = {}): Promise<SessionRow> {
    const now = Date.now();
    const row: SessionRow = {
      agentId: options.agentId ?? null,
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

  /**
   * Names a session after it was created. Queued behind the messages that
   * prompted the name rather than written straight through: the title is read
   * off the transcript, and a row that leads it would describe a conversation
   * storage does not have yet.
   */
  public setTitle(sessionId: string, title: string): void {
    this.#enqueue(sessionId, (database) => {
      database
        .update(sessions)
        .set({ title, updatedAt: Date.now() })
        .where(eq(sessions.sessionId, sessionId))
        .run();
    });
  }

  /** Session metadata without loading its transcript. */
  public async readSession(sessionId: string): Promise<SessionSummary | undefined> {
    await this.#writes;
    return this.#database.exclusive((database) => {
      const row = database.select().from(sessions).where(eq(sessions.sessionId, sessionId)).get();
      if (row === undefined) return undefined;
      return {
        ...(row.agentId === null ? {} : { agentId: row.agentId }),
        createdAt: new Date(row.createdAt),
        sessionId: row.sessionId,
        ...(row.title === null ? {} : { title: row.title }),
        updatedAt: new Date(row.updatedAt),
      };
    });
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

export { SessionStore };

export type {
  AuditAction,
  AuditActionList,
  AuditToolResponse,
  CreateSessionOptions,
  SessionAgentSummary,
  SessionList,
  SessionStoreOptions,
  SessionSummary,
  StoredSession,
};
export type { StoredDecision as DecisionRecord } from '../auth/audit';
