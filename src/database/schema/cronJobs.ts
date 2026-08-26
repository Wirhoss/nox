import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const CRON_JOB_KINDS = ['at', 'cron'] as const;
const CRON_JOB_STATUSES = [
  'aborted',
  'completed',
  'failed',
  'interrupted',
  'maxIterations',
  'queued',
  'running',
  'scheduled',
  'skipped',
] as const;

const CRON_RUN_STATUSES = [
  'aborted',
  'completed',
  'failed',
  'interrupted',
  'maxIterations',
  'queued',
  'running',
  'skipped',
] as const;

type CronJobKind = (typeof CRON_JOB_KINDS)[number];
type CronJobStatus = (typeof CRON_JOB_STATUSES)[number];
type CronRunStatus = (typeof CRON_RUN_STATUSES)[number];

/** Durable schedules target configured agents, independently of any conversation. */
const cronJobs = sqliteTable(
  'cron_jobs',
  {
    agentId: text('agent_id').notNull(),
    createdAt: integer('created_at').notNull(),
    /** Audit only. Deleting the chat that authored a job must not delete the job. */
    createdFromSessionId: text('created_from_session_id'),
    deliveryBrokerId: text('delivery_broker_id'),
    deliveryChannelId: text('delivery_channel_id'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    expression: text('expression'),
    jobId: text('job_id').primaryKey(),
    kind: text('kind', { enum: CRON_JOB_KINDS }).notNull(),
    lastError: text('last_error'),
    lastRunAt: integer('last_run_at'),
    lastRunId: text('last_run_id'),
    lastStatus: text('last_status', { enum: CRON_JOB_STATUSES }),
    name: text('name').notNull(),
    nextRunAt: integer('next_run_at'),
    oneShotAt: integer('one_shot_at'),
    prompt: text('prompt').notNull(),
    timeZone: text('time_zone'),
    toolSetId: text('tool_set_id').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('cron_jobs_due_idx').on(table.enabled, table.nextRunAt),
    index('cron_jobs_scope_idx').on(table.toolSetId),
  ],
);

/** One immutable occurrence and its fresh agent session. */
const cronRuns = sqliteTable(
  'cron_runs',
  {
    agentId: text('agent_id').notNull(),
    completedAt: integer('completed_at'),
    createdAt: integer('created_at').notNull(),
    deliveredAt: integer('delivered_at'),
    deliveryError: text('delivery_error'),
    error: text('error'),
    jobId: text('job_id')
      .notNull()
      .references(() => cronJobs.jobId, { onDelete: 'cascade' }),
    output: text('output'),
    runId: text('run_id').primaryKey(),
    scheduledFor: integer('scheduled_for').notNull(),
    sessionId: text('session_id'),
    startedAt: integer('started_at'),
    status: text('status', { enum: CRON_RUN_STATUSES }).notNull(),
  },
  (table) => [
    index('cron_runs_job_idx').on(table.jobId, table.scheduledFor),
    index('cron_runs_status_idx').on(table.status),
  ],
);

type CronJobRow = typeof cronJobs.$inferSelect;
type CronJobRowInsert = typeof cronJobs.$inferInsert;
type CronRunRow = typeof cronRuns.$inferSelect;
type CronRunRowInsert = typeof cronRuns.$inferInsert;

export { CRON_JOB_KINDS, CRON_JOB_STATUSES, CRON_RUN_STATUSES, cronJobs, cronRuns };

export type {
  CronJobKind,
  CronJobRow,
  CronJobRowInsert,
  CronJobStatus,
  CronRunRow,
  CronRunRowInsert,
  CronRunStatus,
};
