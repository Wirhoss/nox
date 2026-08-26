import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';

import { contentPartSchema } from '../../../../content/content';
import { type CronJobRow, cronJobs, type CronRunRow, cronRuns } from '../../../../database/schema';

import type { Database, NoxTransaction } from '../../../../database/database';
import type { CronJob, CronJobScope, CronRun, CronSchedule } from './model';

function iso(value: null | number): string | undefined {
  return value === null ? undefined : new Date(value).toISOString();
}

function scheduleOf(row: CronJobRow): CronSchedule {
  if (row.kind === 'at') {
    if (row.oneShotAt === null) throw new Error(`Cron job ${row.jobId} has no one-time date.`);
    return { at: new Date(row.oneShotAt).toISOString(), type: 'at' };
  }
  if (row.expression === null || row.timeZone === null) {
    throw new Error(`Cron job ${row.jobId} has an incomplete cron schedule.`);
  }
  return { expression: row.expression, timeZone: row.timeZone, type: 'cron' };
}

function jobFromRow(row: CronJobRow): CronJob {
  return {
    agentId: row.agentId,
    createdAt: new Date(row.createdAt).toISOString(),
    ...(row.createdFromSessionId === null
      ? {}
      : { createdFromSessionId: row.createdFromSessionId }),
    ...(row.deliveryBrokerId === null || row.deliveryChannelId === null
      ? {}
      : { delivery: { brokerId: row.deliveryBrokerId, channelId: row.deliveryChannelId } }),
    enabled: row.enabled,
    jobId: row.jobId,
    ...(row.lastError === null ? {} : { lastError: row.lastError }),
    ...(row.lastRunAt === null ? {} : { lastRunAt: iso(row.lastRunAt) }),
    ...(row.lastRunId === null ? {} : { lastRunId: row.lastRunId }),
    ...(row.lastStatus === null ? {} : { lastStatus: row.lastStatus }),
    name: row.name,
    ...(row.nextRunAt === null ? {} : { nextRunAt: iso(row.nextRunAt) }),
    prompt: row.prompt,
    schedule: scheduleOf(row),
    scope: { toolSetId: row.toolSetId },
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

const outputSchema = z.array(contentPartSchema);

function runFromRow(row: CronRunRow): CronRun {
  const output: unknown = row.output === null ? undefined : JSON.parse(row.output);
  return {
    agentId: row.agentId,
    ...(row.completedAt === null ? {} : { completedAt: iso(row.completedAt) }),
    createdAt: new Date(row.createdAt).toISOString(),
    ...(row.deliveredAt === null ? {} : { deliveredAt: iso(row.deliveredAt) }),
    ...(row.deliveryError === null ? {} : { deliveryError: row.deliveryError }),
    ...(row.error === null ? {} : { error: row.error }),
    jobId: row.jobId,
    ...(output === undefined ? {} : { output: outputSchema.parse(output) }),
    runId: row.runId,
    scheduledFor: new Date(row.scheduledFor).toISOString(),
    ...(row.sessionId === null ? {} : { sessionId: row.sessionId }),
    ...(row.startedAt === null ? {} : { startedAt: iso(row.startedAt) }),
    status: row.status,
  };
}

function scheduleColumns(
  schedule: CronSchedule,
): Pick<CronJobRow, 'expression' | 'kind' | 'oneShotAt' | 'timeZone'> {
  return schedule.type === 'at'
    ? { expression: null, kind: 'at', oneShotAt: new Date(schedule.at).getTime(), timeZone: null }
    : {
        expression: schedule.expression,
        kind: 'cron',
        oneShotAt: null,
        timeZone: schedule.timeZone,
      };
}

function jobToRow(job: CronJob): CronJobRow {
  return {
    agentId: job.agentId,
    createdAt: new Date(job.createdAt).getTime(),
    createdFromSessionId: job.createdFromSessionId ?? null,
    deliveryBrokerId: job.delivery?.brokerId ?? null,
    deliveryChannelId: job.delivery?.channelId ?? null,
    enabled: job.enabled,
    ...scheduleColumns(job.schedule),
    jobId: job.jobId,
    lastError: job.lastError ?? null,
    lastRunAt: job.lastRunAt === undefined ? null : new Date(job.lastRunAt).getTime(),
    lastRunId: job.lastRunId ?? null,
    lastStatus: job.lastStatus ?? null,
    name: job.name,
    nextRunAt: job.nextRunAt === undefined ? null : new Date(job.nextRunAt).getTime(),
    prompt: job.prompt,
    toolSetId: job.scope.toolSetId,
    updatedAt: new Date(job.updatedAt).getTime(),
  };
}

function runToRow(run: CronRun): CronRunRow {
  return {
    agentId: run.agentId,
    completedAt: run.completedAt === undefined ? null : new Date(run.completedAt).getTime(),
    createdAt: new Date(run.createdAt).getTime(),
    deliveredAt: run.deliveredAt === undefined ? null : new Date(run.deliveredAt).getTime(),
    deliveryError: run.deliveryError ?? null,
    error: run.error ?? null,
    jobId: run.jobId,
    output: run.output === undefined ? null : JSON.stringify(run.output),
    runId: run.runId,
    scheduledFor: new Date(run.scheduledFor).getTime(),
    sessionId: run.sessionId ?? null,
    startedAt: run.startedAt === undefined ? null : new Date(run.startedAt).getTime(),
    status: run.status,
  };
}

function replaceJob(transaction: NoxTransaction, job: CronJob): void {
  const row = jobToRow(job);
  transaction
    .update(cronJobs)
    .set({
      agentId: row.agentId,
      createdFromSessionId: row.createdFromSessionId,
      deliveryBrokerId: row.deliveryBrokerId,
      deliveryChannelId: row.deliveryChannelId,
      enabled: row.enabled,
      expression: row.expression,
      kind: row.kind,
      lastError: row.lastError,
      lastRunAt: row.lastRunAt,
      lastRunId: row.lastRunId,
      lastStatus: row.lastStatus,
      name: row.name,
      nextRunAt: row.nextRunAt,
      oneShotAt: row.oneShotAt,
      prompt: row.prompt,
      timeZone: row.timeZone,
      updatedAt: row.updatedAt,
    })
    .where(eq(cronJobs.jobId, job.jobId))
    .run();
}

class CronJobStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  public async count(scope: CronJobScope): Promise<number> {
    const rows = await this.#database.exclusive((database) =>
      database
        .select({ jobId: cronJobs.jobId })
        .from(cronJobs)
        .where(eq(cronJobs.toolSetId, scope.toolSetId))
        .all(),
    );
    return rows.length;
  }

  public async delete(scope: CronJobScope, jobId: string): Promise<boolean> {
    return this.#database.exclusive((database) => {
      const deleted = database
        .delete(cronJobs)
        .where(and(eq(cronJobs.jobId, jobId), eq(cronJobs.toolSetId, scope.toolSetId)))
        .returning({ jobId: cronJobs.jobId })
        .get();
      return deleted !== undefined;
    });
  }

  public async due(now: Date): Promise<CronJob[]> {
    const rows = await this.#database.exclusive((database) =>
      database
        .select()
        .from(cronJobs)
        .where(and(eq(cronJobs.enabled, true), lte(cronJobs.nextRunAt, now.getTime())))
        .orderBy(asc(cronJobs.nextRunAt))
        .all(),
    );
    return rows.map(jobFromRow);
  }

  public async enabled(): Promise<CronJob[]> {
    const rows = await this.#database.exclusive((database) =>
      database
        .select()
        .from(cronJobs)
        .where(eq(cronJobs.enabled, true))
        .orderBy(asc(cronJobs.nextRunAt))
        .all(),
    );
    return rows.map(jobFromRow);
  }

  public async find(scope: CronJobScope, jobId: string): Promise<CronJob | undefined> {
    const row = await this.#database.exclusive((database) =>
      database
        .select()
        .from(cronJobs)
        .where(and(eq(cronJobs.jobId, jobId), eq(cronJobs.toolSetId, scope.toolSetId)))
        .get(),
    );
    return row === undefined ? undefined : jobFromRow(row);
  }

  public async insert(job: CronJob): Promise<void> {
    await this.#database.exclusive((database) => {
      database.insert(cronJobs).values(jobToRow(job)).run();
    });
  }

  public async interruptActive(now: Date): Promise<void> {
    await this.#database.transaction((transaction) => {
      const active = transaction
        .select()
        .from(cronRuns)
        .where(inArray(cronRuns.status, ['queued', 'running']))
        .all();
      const error = 'Nox stopped before this cron run completed.';
      for (const row of active) {
        transaction
          .update(cronRuns)
          .set({ completedAt: now.getTime(), error, status: 'interrupted' })
          .where(eq(cronRuns.runId, row.runId))
          .run();
        transaction
          .update(cronJobs)
          .set({ lastError: error, lastStatus: 'interrupted', updatedAt: now.getTime() })
          .where(and(eq(cronJobs.jobId, row.jobId), eq(cronJobs.lastRunId, row.runId)))
          .run();
      }
    });
  }

  public async list(
    scope: CronJobScope,
    options: { readonly enabled?: boolean; readonly limit: number },
  ): Promise<CronJob[]> {
    const where =
      options.enabled === undefined
        ? eq(cronJobs.toolSetId, scope.toolSetId)
        : and(eq(cronJobs.toolSetId, scope.toolSetId), eq(cronJobs.enabled, options.enabled));
    const rows = await this.#database.exclusive((database) =>
      database
        .select()
        .from(cronJobs)
        .where(where)
        .orderBy(desc(cronJobs.createdAt))
        .limit(options.limit)
        .all(),
    );
    return rows.map(jobFromRow);
  }

  public async listRuns(jobId: string, limit: number): Promise<CronRun[]> {
    const rows = await this.#database.exclusive((database) =>
      database
        .select()
        .from(cronRuns)
        .where(eq(cronRuns.jobId, jobId))
        .orderBy(desc(cronRuns.scheduledFor))
        .limit(limit)
        .all(),
    );
    return rows.map(runFromRow);
  }

  public async replace(job: CronJob): Promise<void> {
    await this.#database.transaction((transaction) => {
      replaceJob(transaction, job);
    });
  }

  public async save(job: CronJob, run: CronRun): Promise<void> {
    await this.#database.transaction((transaction) => {
      replaceJob(transaction, job);
      transaction.insert(cronRuns).values(runToRow(run)).run();
    });
  }

  /** Updates one occurrence without replacing schedule edits made while it was running. */
  public async updateRun(job: CronJob, run: CronRun): Promise<void> {
    await this.#database.transaction((transaction) => {
      transaction.update(cronRuns).set(runToRow(run)).where(eq(cronRuns.runId, run.runId)).run();
      transaction
        .update(cronJobs)
        .set({
          lastError: job.lastError ?? null,
          lastStatus: job.lastStatus ?? null,
          updatedAt: new Date(job.updatedAt).getTime(),
        })
        .where(and(eq(cronJobs.jobId, job.jobId), eq(cronJobs.lastRunId, run.runId)))
        .run();
    });
  }
}

export { CronJobStore };
