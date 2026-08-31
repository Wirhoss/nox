import { ianaTimeZoneSchema, z } from '@nox/extension-api';
import { Cron } from 'croner';

import type { MessageContent, ScheduledRunDelivery } from '@nox/extension-api';

type CronJobStatus =
  | 'aborted'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'maxIterations'
  | 'queued'
  | 'running'
  | 'scheduled'
  | 'skipped';
type CronRunStatus = Exclude<CronJobStatus, 'scheduled'>;

const cronExpressionSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((expression) => {
    try {
      new Cron(expression, { mode: '5-part', paused: true, timezone: 'UTC' });
      return true;
    } catch {
      return false;
    }
  }, 'Use a valid five-field cron expression.');

const cronScheduleInputSchema = z.discriminatedUnion('type', [
  z.object({
    at: z.iso.datetime({ offset: true }),
    type: z.literal('at'),
  }),
  z.object({
    expression: cronExpressionSchema,
    timeZone: ianaTimeZoneSchema.optional(),
    type: z.literal('cron'),
  }),
]);

const cronDeliverySchema = z.object({
  brokerId: z.string().trim().min(1).max(100).describe('Configured broker instance ID.'),
  channelId: z.string().trim().min(1).max(255).describe('Destination channel ID.'),
});

type CronScheduleInput = z.infer<typeof cronScheduleInputSchema>;

type CronSchedule =
  | { readonly at: string; readonly type: 'at' }
  | { readonly expression: string; readonly timeZone: string; readonly type: 'cron' };

interface CronJobScope {
  readonly toolSetId: string;
}

interface CronJobPolicy {
  readonly maxJobs: number;
  readonly timeZone: string;
}

interface CronJob {
  readonly agentId: string;
  readonly createdAt: string;
  readonly createdFromSessionId?: string;
  readonly delivery?: ScheduledRunDelivery;
  readonly enabled: boolean;
  readonly jobId: string;
  readonly lastError?: string;
  readonly lastRunAt?: string;
  readonly lastRunId?: string;
  readonly lastStatus?: CronJobStatus;
  readonly name: string;
  readonly nextRunAt?: string;
  readonly prompt: string;
  readonly schedule: CronSchedule;
  readonly scope: CronJobScope;
  readonly updatedAt: string;
}

interface CronRun {
  readonly agentId: string;
  readonly completedAt?: string;
  readonly createdAt: string;
  readonly deliveredAt?: string;
  readonly deliveryError?: string;
  readonly error?: string;
  readonly jobId: string;
  readonly output?: readonly MessageContent[];
  readonly runId: string;
  readonly scheduledFor: string;
  readonly sessionId?: string;
  readonly startedAt?: string;
  readonly status: CronRunStatus;
}

interface CreateCronJobInput {
  readonly agentId: string;
  readonly createdFromSessionId: string;
  readonly delivery?: ScheduledRunDelivery;
  readonly name: string;
  readonly prompt: string;
  readonly schedule: CronScheduleInput;
  readonly scope: CronJobScope;
}

interface UpdateCronJobInput {
  readonly agentId?: string;
  readonly delivery?: null | ScheduledRunDelivery;
  readonly enabled?: boolean;
  readonly name?: string;
  readonly prompt?: string;
  readonly schedule?: CronScheduleInput;
}

interface CronRunSubmission {
  readonly job: CronJob;
  readonly run: CronRun;
}

function scheduleFrom(input: CronScheduleInput, appTimeZone: string): CronSchedule {
  return input.type === 'at'
    ? { at: new Date(input.at).toISOString(), type: 'at' }
    : {
        expression: input.expression,
        timeZone: input.timeZone ?? appTimeZone,
        type: 'cron',
      };
}

function nextRun(schedule: CronSchedule, after: Date): Date | undefined {
  if (schedule.type === 'at') {
    const at = new Date(schedule.at);
    return at.getTime() > after.getTime() ? at : undefined;
  }

  return (
    new Cron(schedule.expression, {
      mode: '5-part',
      paused: true,
      timezone: schedule.timeZone,
    }).nextRun(after) ?? undefined
  );
}

function assertFutureRun(schedule: CronSchedule, now: Date): Date {
  const next = nextRun(schedule, now);
  if (next === undefined) {
    throw new RangeError(
      schedule.type === 'at'
        ? 'A one-time job must be scheduled in the future.'
        : 'The cron expression has no future occurrence.',
    );
  }
  return next;
}

export {
  assertFutureRun,
  cronDeliverySchema,
  cronExpressionSchema,
  cronScheduleInputSchema,
  nextRun,
  scheduleFrom,
};

export type {
  CreateCronJobInput,
  CronJob,
  CronJobPolicy,
  CronJobScope,
  CronRun,
  CronRunSubmission,
  CronSchedule,
  CronScheduleInput,
  UpdateCronJobInput,
};
