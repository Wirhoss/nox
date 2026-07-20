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

type StoredActivity = {
  cursor: number;
  event: Exclude<GatewayEvent, { type: 'assistantTextFragment' }>;
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
    return this.database
      .select({ payload: messageTable.payload })
      .from(messageTable)
      .where(eq(messageTable.sessionId, sessionId))
      .orderBy(messageTable.position)
      .all()
      .map((row) => {
        const message = row.payload;
        if (message.role === 'toolResponse' && message.execution === undefined) {
          message.execution = 'immediate';
        }
        return message;
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
    if (event.type === 'assistantTextFragment') {
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

  public getRecentActivities(sessionId: string, limit = 50): StoredActivity[] {
    return this.database.select().from(sessionEventTable)
      .where(eq(sessionEventTable.sessionId, sessionId))
      .orderBy(desc(sessionEventTable.id))
      .limit(limit)
      .all()
      .reverse()
      .map((record) => ({
        cursor: record.id,
        event: record.payload as Exclude<GatewayEvent, { type: 'assistantTextFragment' }>,
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
  RunSummary,
  StoredActivity,
};
