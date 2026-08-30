import {
  type Disposable,
  type Logger,
  Mutex,
  type ScheduledRunDelivery,
  type ScheduledRunHost,
} from '@nox/extension-api';
import { nanoid } from 'nanoid';

import {
  assertFutureRun,
  type CreateCronJobInput,
  type CronJob,
  type CronJobPolicy,
  type CronJobScope,
  type CronRun,
  type CronRunSubmission,
  nextRun,
  scheduleFrom,
  type UpdateCronJobInput,
} from './model';

import type { CronJobStore } from './store';

const MAX_TIMER_DELAY_MS = 2_147_000_000;

type CronPolicyResolver = (toolSetId: string) => CronJobPolicy | undefined;

interface CronJobManager {
  agents(signal: AbortSignal): Promise<readonly string[]>;
  deliveryBrokers(signal: AbortSignal): Promise<readonly string[]>;
  /** Where the transport that owns this session is being spoken to, if one does. */
  deliveryHere(
    askingSessionId: string,
    signal: AbortSignal,
  ): Promise<ScheduledRunDelivery | undefined>;
  create(input: CreateCronJobInput, policy: CronJobPolicy, signal: AbortSignal): Promise<CronJob>;
  delete(scope: CronJobScope, jobId: string): Promise<boolean>;
  get(scope: CronJobScope, jobId: string): Promise<CronJob | undefined>;
  list(
    scope: CronJobScope,
    options: { readonly enabled?: boolean; readonly limit: number },
  ): Promise<readonly CronJob[]>;
  listRuns(scope: CronJobScope, jobId: string, limit: number): Promise<readonly CronRun[]>;
  runNow(scope: CronJobScope, jobId: string): Promise<CronRunSubmission>;
  update(
    scope: CronJobScope,
    jobId: string,
    input: UpdateCronJobInput,
    policy: CronJobPolicy,
    signal: AbortSignal,
  ): Promise<CronJob>;
}

interface CronSchedulerOptions {
  readonly host: ScheduledRunHost;
  readonly logger: Logger;
  readonly policyFor: CronPolicyResolver;
  readonly store: CronJobStore;
}

function withoutNext(job: CronJob): CronJob {
  const { nextRunAt: _nextRunAt, ...rest } = job;
  return rest;
}

function withoutError(job: CronJob): CronJob {
  const { lastError: _lastError, ...rest } = job;
  return rest;
}

function withNext(job: CronJob, next: Date | undefined): CronJob {
  const clean = withoutNext(job);
  return next === undefined ? clean : { ...clean, nextRunAt: next.toISOString() };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function runId(): string {
  return `cronrun_${nanoid(16)}`;
}

function sessionId(): string {
  return `cron_session_${nanoid(16)}`;
}

/** One durable timer wheel shared by every configured cronjobs tool-set instance. */
class CronScheduler implements CronJobManager, Disposable {
  readonly #host: ScheduledRunHost;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #inFlightJobs = new Set<string>();
  readonly #lifetime = new AbortController();
  readonly #logger: Logger;
  readonly #mutex = new Mutex();
  readonly #policyFor: CronPolicyResolver;
  readonly #store: CronJobStore;

  #disposed = false;
  #started?: Promise<void>;
  #timer?: ReturnType<typeof setTimeout>;

  constructor(options: CronSchedulerOptions) {
    this.#host = options.host;
    this.#logger = options.logger;
    this.#policyFor = options.policyFor;
    this.#store = options.store;
  }

  /** Starts recovery and arms the durable timer wheel. Safe to call more than once. */
  public start(): Promise<void> {
    this.#started ??= this.#initialize();
    return this.#started;
  }

  public async agents(signal: AbortSignal): Promise<readonly string[]> {
    await this.start();
    this.#assertActive();
    return this.#host.agentIds(signal);
  }

  public async deliveryBrokers(signal: AbortSignal): Promise<readonly string[]> {
    await this.start();
    this.#assertActive();
    return this.#host.deliveryBrokerIds(signal);
  }

  public async deliveryHere(
    askingSessionId: string,
    signal: AbortSignal,
  ): Promise<ScheduledRunDelivery | undefined> {
    await this.start();
    this.#assertActive();
    return this.#host.deliveryOrigin(askingSessionId, signal);
  }

  public async create(
    input: CreateCronJobInput,
    policy: CronJobPolicy,
    signal: AbortSignal,
  ): Promise<CronJob> {
    await this.start();
    await Promise.all([
      this.#assertAgent(input.agentId, signal),
      this.#assertDelivery(input.delivery, signal),
    ]);
    return this.#mutex.run(async () => {
      this.#assertActive();
      if ((await this.#store.count(input.scope)) >= policy.maxJobs) {
        throw new RangeError(
          `This cron tool set already has its limit of ${String(policy.maxJobs)} jobs.`,
        );
      }

      const now = new Date();
      const schedule = scheduleFrom(input.schedule, policy.timeZone);
      const next = assertFutureRun(schedule, now);
      const job: CronJob = {
        agentId: input.agentId,
        createdAt: now.toISOString(),
        createdFromSessionId: input.createdFromSessionId,
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
        enabled: true,
        jobId: `cron_${nanoid(16)}`,
        lastStatus: 'scheduled',
        name: input.name,
        nextRunAt: next.toISOString(),
        prompt: input.prompt,
        schedule,
        scope: input.scope,
        updatedAt: now.toISOString(),
      };
      await this.#store.insert(job);
      await this.#armLocked();
      return job;
    });
  }

  public async delete(scope: CronJobScope, jobId: string): Promise<boolean> {
    await this.start();
    return this.#mutex.run(async () => {
      this.#assertActive();
      if (this.#inFlightJobs.has(jobId)) {
        throw new Error(`Cron job "${jobId}" is running and cannot be deleted yet.`);
      }
      const deleted = await this.#store.delete(scope, jobId);
      await this.#armLocked();
      return deleted;
    });
  }

  public async dispose(): Promise<void> {
    this.#disposed = true;
    this.#lifetime.abort(new Error('Cron scheduler stopped.'));
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#mutex.idle;
    await Promise.allSettled([...this.#inFlight]);
  }

  public async get(scope: CronJobScope, jobId: string): Promise<CronJob | undefined> {
    await this.start();
    this.#assertActive();
    return this.#store.find(scope, jobId);
  }

  public async list(
    scope: CronJobScope,
    options: { readonly enabled?: boolean; readonly limit: number },
  ): Promise<readonly CronJob[]> {
    await this.start();
    this.#assertActive();
    return this.#store.list(scope, options);
  }

  public async listRuns(
    scope: CronJobScope,
    jobId: string,
    limit: number,
  ): Promise<readonly CronRun[]> {
    await this.start();
    this.#assertActive();
    await this.#required(scope, jobId);
    return this.#store.listRuns(jobId, limit);
  }

  public async runNow(scope: CronJobScope, jobId: string): Promise<CronRunSubmission> {
    await this.start();
    return this.#mutex.run(async () => {
      this.#assertActive();
      const job = await this.#required(scope, jobId);
      if (this.#inFlightJobs.has(jobId)) {
        throw new Error(`Cron job "${jobId}" is already running.`);
      }
      const submission = await this.#queueLocked(job, new Date(), true);
      await this.#armLocked();
      return submission;
    });
  }

  public async update(
    scope: CronJobScope,
    jobId: string,
    input: UpdateCronJobInput,
    policy: CronJobPolicy,
    signal: AbortSignal,
  ): Promise<CronJob> {
    await this.start();
    await Promise.all([
      input.agentId === undefined ? undefined : this.#assertAgent(input.agentId, signal),
      input.delivery === undefined || input.delivery === null
        ? undefined
        : this.#assertDelivery(input.delivery, signal),
    ]);
    return this.#mutex.run(async () => {
      this.#assertActive();
      const current = await this.#required(scope, jobId);
      const now = new Date();
      const schedule =
        input.schedule === undefined
          ? current.schedule
          : scheduleFrom(input.schedule, policy.timeZone);
      const enabled = input.enabled ?? current.enabled;
      let delivery = current.delivery;
      if (input.delivery === null) delivery = undefined;
      else if (input.delivery !== undefined) delivery = input.delivery;

      let updated: CronJob = withoutError({
        ...current,
        agentId: input.agentId ?? current.agentId,
        ...(delivery === undefined ? { delivery: undefined } : { delivery }),
        enabled,
        lastStatus: 'scheduled',
        name: input.name ?? current.name,
        prompt: input.prompt ?? current.prompt,
        schedule,
        updatedAt: now.toISOString(),
      });
      if (!enabled) {
        updated = withoutNext(updated);
      } else if (
        input.schedule !== undefined ||
        input.enabled === true ||
        updated.nextRunAt === undefined ||
        new Date(updated.nextRunAt).getTime() <= now.getTime()
      ) {
        updated = withNext(updated, assertFutureRun(schedule, now));
      }

      await this.#store.replace(updated);
      await this.#armLocked();
      return updated;
    });
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('Cron scheduler is stopped.');
  }

  async #assertAgent(agentId: string, signal: AbortSignal): Promise<void> {
    const agents = await this.#host.agentIds(signal);
    if (agents.includes(agentId)) return;
    throw new Error(
      agents.length === 0
        ? `No configured agent can run cron job "${agentId}".`
        : `Agent "${agentId}" is not configured. Available: ${agents.join(', ')}.`,
    );
  }

  async #assertDelivery(
    delivery: ScheduledRunDelivery | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (delivery === undefined) return;
    const brokers = await this.#host.deliveryBrokerIds(signal);
    if (!brokers.includes(delivery.brokerId)) {
      throw new Error(
        brokers.length === 0
          ? `No configured broker can deliver to channel "${delivery.channelId}".`
          : `Broker "${delivery.brokerId}" is not configured. Available: ${brokers.join(', ')}.`,
      );
    }

    // The broker being real says nothing about the channel being real, and the
    // channel is the half a caller invents. Checked here rather than at the
    // first run because this is the last moment someone is still present to be
    // told: a schedule stored with a wrong address fires into nothing, at a
    // time chosen precisely because nobody is watching.
    if (await this.#host.canDeliverTo(delivery, signal)) return;
    throw new Error(
      `Broker "${delivery.brokerId}" cannot deliver to channel "${delivery.channelId}". ` +
        'Check the channel ID, or use the one this conversation is already on.',
    );
  }

  async #armLocked(): Promise<void> {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#disposed) return;

    const next = (await this.#store.enabled()).find((job) => job.nextRunAt !== undefined);
    if (next?.nextRunAt === undefined) return;
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, new Date(next.nextRunAt).getTime() - Date.now()),
    );
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#mutex
        .run(async () => {
          if (this.#disposed) return;
          await this.#tickLocked();
          await this.#armLocked();
        })
        .catch((error: unknown) => {
          this.#logger.error({ err: error }, 'Cron scheduler tick failed.');
        });
    }, delay);
    this.#timer.unref();
  }

  async #initialize(): Promise<void> {
    await this.#mutex.run(async () => {
      this.#assertActive();
      const now = new Date();
      await this.#store.interruptActive(now);
      for (const job of await this.#store.enabled()) {
        if (job.nextRunAt !== undefined && new Date(job.nextRunAt).getTime() > now.getTime()) {
          continue;
        }
        await this.#skipLocked(
          job,
          job.nextRunAt === undefined ? now : new Date(job.nextRunAt),
          now,
          'The scheduled occurrence was missed while Nox was not running.',
        );
      }
      await this.#armLocked();
    });
  }

  async #required(scope: CronJobScope, jobId: string): Promise<CronJob> {
    const job = await this.#store.find(scope, jobId);
    if (job === undefined) throw new Error(`Cron job "${jobId}" does not exist.`);
    return job;
  }

  async #queueLocked(
    job: CronJob,
    scheduledFor: Date,
    preserveSchedule: boolean,
  ): Promise<CronRunSubmission> {
    const now = new Date();
    const next = preserveSchedule
      ? job.nextRunAt === undefined
        ? undefined
        : new Date(job.nextRunAt)
      : nextRun(job.schedule, now);
    const run: CronRun = {
      agentId: job.agentId,
      createdAt: now.toISOString(),
      jobId: job.jobId,
      runId: runId(),
      scheduledFor: scheduledFor.toISOString(),
      sessionId: sessionId(),
      status: 'queued',
    };
    let queued: CronJob = withNext(
      withoutError({
        ...job,
        enabled: preserveSchedule
          ? job.enabled
          : job.schedule.type === 'cron' && next !== undefined,
        lastRunAt: now.toISOString(),
        lastRunId: run.runId,
        lastStatus: 'queued',
        updatedAt: now.toISOString(),
      }),
      next,
    );
    if (!preserveSchedule && job.schedule.type === 'at') queued = withoutNext(queued);
    await this.#store.save(queued, run);
    this.#launch(queued, run);
    return { job: queued, run };
  }

  #launch(job: CronJob, run: CronRun): void {
    this.#inFlightJobs.add(job.jobId);
    const execution = this.#execute(job, run)
      .catch((error: unknown) => {
        this.#logger.error(
          { err: error, jobId: job.jobId, runId: run.runId },
          'Cron run state could not be persisted.',
        );
      })
      .finally(() => {
        this.#inFlight.delete(execution);
        this.#inFlightJobs.delete(job.jobId);
      });
    this.#inFlight.add(execution);
  }

  async #execute(job: CronJob, run: CronRun): Promise<void> {
    const started = new Date();
    let runningJob: CronJob = {
      ...job,
      lastStatus: 'running',
      updatedAt: started.toISOString(),
    };
    let runningRun: CronRun = {
      ...run,
      startedAt: started.toISOString(),
      status: 'running',
    };
    await this.#store.updateRun(runningJob, runningRun);

    try {
      if (this.#policyFor(job.scope.toolSetId) === undefined) {
        throw new Error(`Cron tool set "${job.scope.toolSetId}" is no longer configured.`);
      }
      const result = await this.#host.runScheduledAgent({
        agentId: job.agentId,
        causeId: run.runId,
        ...(job.delivery === undefined ? {} : { delivery: job.delivery }),
        name: job.name,
        prompt: job.prompt,
        sessionId: run.sessionId ?? sessionId(),
        signal: this.#lifetime.signal,
      });
      const failure = result.deliveryError ?? result.error;
      runningRun = {
        ...runningRun,
        completedAt: result.completedAt.toISOString(),
        ...(result.deliveredAt === undefined
          ? {}
          : { deliveredAt: result.deliveredAt.toISOString() }),
        ...(result.deliveryError === undefined ? {} : { deliveryError: result.deliveryError }),
        ...(result.error === undefined ? {} : { error: result.error }),
        output: result.content,
        sessionId: result.sessionId,
        startedAt: result.startedAt.toISOString(),
        status: result.status,
      };
      runningJob = {
        ...runningJob,
        ...(failure === undefined ? { lastError: undefined } : { lastError: failure }),
        lastStatus: result.deliveryError === undefined ? result.status : 'failed',
        updatedAt: result.completedAt.toISOString(),
      };
    } catch (error) {
      const completed = new Date();
      const message = errorMessage(error);
      const interrupted = this.#lifetime.signal.aborted;
      runningRun = {
        ...runningRun,
        completedAt: completed.toISOString(),
        error: message,
        status: interrupted ? 'interrupted' : 'failed',
      };
      runningJob = {
        ...runningJob,
        lastError: message,
        lastStatus: interrupted ? 'interrupted' : 'failed',
        updatedAt: completed.toISOString(),
      };
    }
    await this.#store.updateRun(runningJob, runningRun);
  }

  async #skipLocked(job: CronJob, scheduledFor: Date, now: Date, error: string): Promise<void> {
    const next = nextRun(job.schedule, now);
    const run: CronRun = {
      agentId: job.agentId,
      completedAt: now.toISOString(),
      createdAt: now.toISOString(),
      error,
      jobId: job.jobId,
      runId: runId(),
      scheduledFor: scheduledFor.toISOString(),
      status: 'skipped',
    };
    let skipped = withNext(
      {
        ...job,
        enabled: next !== undefined,
        lastError: error,
        lastRunId: run.runId,
        lastStatus: 'skipped',
        updatedAt: now.toISOString(),
      },
      next,
    );
    if (next === undefined) skipped = withoutNext(skipped);
    await this.#store.save(skipped, run);
  }

  async #tickLocked(): Promise<void> {
    const now = new Date();
    for (const job of await this.#store.due(now)) {
      if (this.#inFlightJobs.has(job.jobId)) {
        await this.#skipLocked(
          job,
          job.nextRunAt === undefined ? now : new Date(job.nextRunAt),
          now,
          'The occurrence was skipped because the previous run is still active.',
        );
      } else {
        await this.#queueLocked(
          job,
          job.nextRunAt === undefined ? now : new Date(job.nextRunAt),
          false,
        );
      }
    }
  }
}

export { CronScheduler };

export type { CronJobManager, CronPolicyResolver, CronSchedulerOptions };
