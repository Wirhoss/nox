import { and, desc, eq, gte } from 'drizzle-orm';

import { messageTable, sessionTable } from './schema';

import type { Message } from '../provider';
import type { NoxDatabase } from './database';
import type { NewSessionRecord, SessionRecord } from './schema';

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
