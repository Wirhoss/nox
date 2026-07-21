import { asc, desc, eq, like, or } from 'drizzle-orm';

import { deliberationTable, deliberationTurnTable } from './schema';

import type { NoxDatabase } from './database';
import type {
  DeliberationRecord,
  DeliberationTerminationReason,
  DeliberationTurnRecord,
  NewDeliberationRecord,
  NewDeliberationTurnRecord,
} from './schema';

type DeliberationDetail = DeliberationRecord & { turns: DeliberationTurnRecord[] };

class DeliberationStore {
  public constructor(private readonly database: NoxDatabase) {}

  public insert(record: NewDeliberationRecord): DeliberationRecord {
    return this.database.insert(deliberationTable).values(record).returning().get();
  }

  public get(deliberationId: string): DeliberationRecord | null {
    return this.database.select().from(deliberationTable)
      .where(eq(deliberationTable.deliberationId, deliberationId))
      .get() ?? null;
  }

  public getDetail(deliberationId: string): DeliberationDetail | null {
    const deliberation = this.get(deliberationId);
    if (!deliberation) return null;
    return { ...deliberation, turns: this.listTurns(deliberationId) };
  }

  public list(query?: string): DeliberationRecord[] {
    const needle = query?.trim();
    return this.database.select().from(deliberationTable)
      .where(needle ? or(
        like(deliberationTable.title, `%${needle}%`),
        like(deliberationTable.question, `%${needle}%`),
      ) : undefined)
      .orderBy(desc(deliberationTable.updatedAt))
      .all();
  }

  public recoverInterrupted(): void {
    const now = new Date();
    this.database.update(deliberationTable).set({
      completedAt: now,
      error: 'Execution was interrupted when Nox stopped.',
      status: 'failed',
      updatedAt: now,
    }).where(eq(deliberationTable.status, 'active')).run();
  }

  public updateConfiguration(
    deliberationId: string,
    input: { moderatorBlueprintId: string; participantBlueprintIds: string[]; rounds: number },
  ): DeliberationRecord | null {
    return this.database.update(deliberationTable).set({
      ...input,
      updatedAt: new Date(),
    }).where(eq(deliberationTable.deliberationId, deliberationId)).returning().get() ?? null;
  }

  public begin(deliberationId: string): DeliberationRecord | null {
    const now = new Date();
    this.database.delete(deliberationTurnTable)
      .where(eq(deliberationTurnTable.deliberationId, deliberationId)).run();
    return this.database.update(deliberationTable).set({
      completedAt: null,
      consensusReached: false,
      currentRound: 0,
      error: null,
      finalReport: null,
      startedAt: now,
      status: 'active',
      terminationReason: null,
      updatedAt: now,
    }).where(eq(deliberationTable.deliberationId, deliberationId)).returning().get() ?? null;
  }

  public setCurrentRound(deliberationId: string, currentRound: number): void {
    this.database.update(deliberationTable).set({ currentRound, updatedAt: new Date() })
      .where(eq(deliberationTable.deliberationId, deliberationId)).run();
  }

  public complete(
    deliberationId: string,
    finalReport: string,
    consensusReached: boolean,
    terminationReason: DeliberationTerminationReason,
  ): void {
    const now = new Date();
    this.database.update(deliberationTable).set({
      completedAt: now,
      error: null,
      finalReport,
      consensusReached,
      status: 'completed',
      terminationReason,
      updatedAt: now,
    }).where(eq(deliberationTable.deliberationId, deliberationId)).run();
  }

  public fail(deliberationId: string, error: string): void {
    const now = new Date();
    this.database.update(deliberationTable).set({
      completedAt: now,
      error,
      status: 'failed',
      updatedAt: now,
    }).where(eq(deliberationTable.deliberationId, deliberationId)).run();
  }

  public cancel(deliberationId: string): void {
    const now = new Date();
    this.database.update(deliberationTable).set({
      completedAt: now,
      status: 'cancelled',
      updatedAt: now,
    }).where(eq(deliberationTable.deliberationId, deliberationId)).run();
  }

  public appendTurn(record: NewDeliberationTurnRecord): DeliberationTurnRecord {
    return this.database.insert(deliberationTurnTable).values(record).returning().get();
  }

  public listTurns(deliberationId: string): DeliberationTurnRecord[] {
    return this.database.select().from(deliberationTurnTable)
      .where(eq(deliberationTurnTable.deliberationId, deliberationId))
      .orderBy(asc(deliberationTurnTable.turnId)).all();
  }
}

export {
  DeliberationStore,
};

export type {
  DeliberationDetail,
};
