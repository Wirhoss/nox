import { and, count, desc, eq, gte } from 'drizzle-orm';

import { messageTable, runTable, sessionEventTable, sessionTable } from './schema';

import type { GatewayEvent } from '../gateway/events';
import type { Message } from '../provider';
import type { NoxDatabase } from './database';
import type { NewSessionRecord, SessionRecord } from './schema';

type RunSummary = {
  runId: string;
  modelId: string | null;
  status: 'running' | 'completed' | 'aborted' | 'maxIterations' | 'failed';
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
};

type RunListItem = RunSummary & {
  blueprintId: string;
  sessionId: string;
};

type SessionListItem = SessionRecord & {
  latestRun: RunSummary | null;
  runCount: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
};

type StoredMessage = {
  createdAt: Date;
  message: Message;
  position: number;
};

type StoredActivity = {
  cursor: number;
  event: Exclude<GatewayEvent, { type: 'assistantReasoningFragment' | 'assistantTextFragment' }>;
  receivedAt: Date;
};

class SessionStore {
  private database: NoxDatabase;

  constructor(database: NoxDatabase) {
    this.database = database;
  }

  public insertSession(record: NewSessionRecord): void {
    this.database.insert(sessionTable).values(record).run();
  }

  public getSession(sessionId: string): SessionRecord | null {
    return this.database
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.sessionId, sessionId))
      .get() ?? null;
  }

  public listSessions(blueprintId?: string): SessionRecord[] {
    return this.database
      .select()
      .from(sessionTable)
      .where(blueprintId === undefined ? undefined : eq(sessionTable.blueprintId, blueprintId))
      .orderBy(desc(sessionTable.updatedAt))
      .all();
  }

  public listSessionsWithStats(blueprintId?: string): SessionListItem[] {
    const sessions = this.listSessions(blueprintId);
    const runs = this.database
      .select()
      .from(runTable)
      .orderBy(desc(runTable.startedAt))
      .all();
    const stats = new Map<string, {
      latestRun: RunSummary;
      runCount: number;
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
    }>();

    for (const run of runs) {
      const existing = stats.get(run.sessionId);
      const usage = {
        inputTokens: run.inputTokens + (existing?.usage.inputTokens ?? 0),
        outputTokens: run.outputTokens + (existing?.usage.outputTokens ?? 0),
        cacheReadTokens: run.cacheReadTokens + (existing?.usage.cacheReadTokens ?? 0),
      };
      const summary: RunSummary = {
        runId: run.runId,
        modelId: run.modelId,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        durationMs: run.durationMs,
        usage: {
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          cacheReadTokens: run.cacheReadTokens,
        },
      };
      stats.set(run.sessionId, {
        latestRun: existing?.latestRun ?? summary,
        runCount: (existing?.runCount ?? 0) + 1,
        usage,
      });
    }

    return sessions.map((session) => {
      const sessionStats = stats.get(session.sessionId);
      return {
        ...session,
        latestRun: sessionStats?.latestRun ?? null,
        runCount: sessionStats?.runCount ?? 0,
        usage: sessionStats?.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      };
    });
  }

  public deleteSession(sessionId: string): boolean {
    this.database
      .delete(messageTable)
      .where(eq(messageTable.sessionId, sessionId))
      .run();
    const result = this.database
      .delete(sessionTable)
      .where(eq(sessionTable.sessionId, sessionId))
      .run();
    return result.changes > 0;
  }

  public getMessages(sessionId: string): Message[] {
    return this.getMessageEntries(sessionId).map((entry) => entry.message);
  }

  public getMessageEntries(sessionId: string): StoredMessage[] {
    return this.database
      .select({
        createdAt: messageTable.createdAt,
        payload: messageTable.payload,
        position: messageTable.position,
      })
      .from(messageTable)
      .where(eq(messageTable.sessionId, sessionId))
      .orderBy(messageTable.position)
      .all()
      .map((row) => {
        const message = row.payload;
        if (message.role === 'toolResponse' && message.execution === undefined) {
          message.execution = 'immediate';
        }
        return { createdAt: row.createdAt, message, position: row.position };
      });
  }

  public saveMessage(sessionId: string, position: number, message: Message): void {
    const execution = message.role === 'toolResponse' ? message.execution : null;
    this.database
      .insert(messageTable)
      .values({ sessionId, position, role: message.role, execution, payload: message })
      .onConflictDoUpdate({
        target: [messageTable.sessionId, messageTable.position],
        set: { role: message.role, execution, payload: message },
      })
      .run();
    this.touchSession(sessionId);
  }

  public truncateMessages(sessionId: string, length: number): void {
    this.database
      .delete(messageTable)
      .where(and(
        eq(messageTable.sessionId, sessionId),
        gte(messageTable.position, length),
      ))
      .run();
    this.touchSession(sessionId);
  }

  public recordEvent(sessionId: string, event: GatewayEvent): void {
    if (event.type === 'assistantTextFragment' || event.type === 'assistantReasoningFragment') {
      return;
    }
    this.database.insert(sessionEventTable).values({
      sessionId,
      type: event.type,
      payload: event,
    }).run();

    if (event.type === 'runStarted') {
      this.database.insert(runTable).values({
        runId: event.runId,
        sessionId,
        modelId: event.modelId,
        status: 'running',
        startedAt: new Date(event.startedAt),
      }).onConflictDoUpdate({
        target: runTable.runId,
        set: {
          modelId: event.modelId,
          status: 'running',
          startedAt: new Date(event.startedAt),
          completedAt: null,
          durationMs: null,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
        },
      }).run();
      return;
    }

    if (event.type === 'runCompleted') {
      const completedAt = new Date();
      const result = this.database.update(runTable).set({
        status: event.status,
        completedAt,
        durationMs: event.durationMs,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cacheReadTokens: event.usage.cacheReadTokens,
      }).where(eq(runTable.runId, event.runId)).run();
      if (result.changes === 0) {
        this.database.insert(runTable).values({
          runId: event.runId,
          sessionId,
          status: event.status,
          startedAt: new Date(completedAt.getTime() - event.durationMs),
          completedAt,
          durationMs: event.durationMs,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cacheReadTokens: event.usage.cacheReadTokens,
        }).run();
      }
    }
  }

  public getLatestRun(sessionId: string): RunSummary | null {
    const record = this.database.select().from(runTable)
      .where(eq(runTable.sessionId, sessionId))
      .orderBy(desc(runTable.startedAt))
      .limit(1)
      .get();
    if (!record) {
      return null;
    }
    return {
      runId: record.runId,
      modelId: record.modelId,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      durationMs: record.durationMs,
      usage: {
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cacheReadTokens: record.cacheReadTokens,
      },
    };
  }

  public listRuns(options: {
    blueprintId?: string;
    limit?: number;
    offset?: number;
    sessionId?: string;
    status?: RunSummary['status'];
  } = {}): RunListItem[] {
    const { blueprintId, limit = 50, offset = 0, sessionId, status } = options;
    const filters = [
      blueprintId === undefined ? undefined : eq(sessionTable.blueprintId, blueprintId),
      sessionId === undefined ? undefined : eq(runTable.sessionId, sessionId),
      status === undefined ? undefined : eq(runTable.status, status),
    ].filter((filter) => filter !== undefined);
    const where = filters.length === 0 ? undefined : and(...filters);

    return this.database
      .select({
        blueprintId: sessionTable.blueprintId,
        cacheReadTokens: runTable.cacheReadTokens,
        completedAt: runTable.completedAt,
        durationMs: runTable.durationMs,
        inputTokens: runTable.inputTokens,
        modelId: runTable.modelId,
        outputTokens: runTable.outputTokens,
        runId: runTable.runId,
        sessionId: runTable.sessionId,
        startedAt: runTable.startedAt,
        status: runTable.status,
      })
      .from(runTable)
      .innerJoin(sessionTable, eq(runTable.sessionId, sessionTable.sessionId))
      .where(where)
      .orderBy(desc(runTable.startedAt))
      .limit(limit)
      .offset(offset)
      .all()
      .map((record) => ({
        blueprintId: record.blueprintId,
        sessionId: record.sessionId,
        runId: record.runId,
        modelId: record.modelId,
        status: record.status,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        durationMs: record.durationMs,
        usage: {
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cacheReadTokens: record.cacheReadTokens,
        },
      }));
  }

  public getRecentActivities(sessionId: string, limit = 50): StoredActivity[] {
    return this.database.select().from(sessionEventTable)
      .where(eq(sessionEventTable.sessionId, sessionId))
      .orderBy(desc(sessionEventTable.id))
      .limit(limit)
      .all()
      .reverse()
      .map((record) => ({
        cursor: record.id,
        event: record.payload as Exclude<GatewayEvent, { type: 'assistantReasoningFragment' | 'assistantTextFragment' }>,
        receivedAt: record.createdAt,
      }));
  }

  public getActivityCount(sessionId: string): number {
    return this.database.select({ value: count() }).from(sessionEventTable)
      .where(eq(sessionEventTable.sessionId, sessionId))
      .get()?.value ?? 0;
  }

  private touchSession(sessionId: string): void {
    this.database
      .update(sessionTable)
      .set({ updatedAt: new Date() })
      .where(eq(sessionTable.sessionId, sessionId))
      .run();
  }
}

export {
  SessionStore,
};

export type {
  RunListItem,
  RunSummary,
  SessionListItem,
  StoredActivity,
  StoredMessage,
};
