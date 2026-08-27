import type { CronJob, CronJobScope, CronRun } from './model';
import type { ExtensionStateTransaction, ExtensionStorage } from '@nox/extension-api';

const JOBS = 'jobs';
const RUNS = 'runs';

function parseJob(value: unknown): CronJob {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid stored cron job.');
  return value as CronJob;
}

function parseRun(value: unknown): CronRun {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid stored cron run.');
  return value as CronRun;
}

function jobs(transaction: ExtensionStateTransaction): CronJob[] {
  return transaction.entries(JOBS, parseJob).map((entry) => entry.value);
}

function runs(transaction: ExtensionStateTransaction): CronRun[] {
  return transaction.entries(RUNS, parseRun).map((entry) => entry.value);
}

function inScope(job: CronJob, scope: CronJobScope): boolean {
  return job.scope.toolSetId === scope.toolSetId;
}

class CronJobStore {
  readonly #storage: ExtensionStorage;

  constructor(storage: ExtensionStorage) {
    this.#storage = storage;
  }

  public count(scope: CronJobScope): Promise<number> {
    return this.#storage.transact(
      (transaction) => jobs(transaction).filter((job) => inScope(job, scope)).length,
    );
  }

  public delete(scope: CronJobScope, jobId: string): Promise<boolean> {
    return this.#storage.transact((transaction) => {
      const job = transaction.get(JOBS, jobId, parseJob);
      if (job === undefined || !inScope(job, scope)) return false;
      transaction.delete(JOBS, jobId);
      for (const run of runs(transaction)) {
        if (run.jobId === jobId) transaction.delete(RUNS, run.runId);
      }
      return true;
    });
  }

  public due(now: Date): Promise<CronJob[]> {
    return this.#storage.transact((transaction) =>
      jobs(transaction)
        .filter(
          (job) =>
            job.enabled &&
            job.nextRunAt !== undefined &&
            new Date(job.nextRunAt).getTime() <= now.getTime(),
        )
        .sort((left, right) => (left.nextRunAt ?? '').localeCompare(right.nextRunAt ?? '')),
    );
  }

  public enabled(): Promise<CronJob[]> {
    return this.#storage.transact((transaction) =>
      jobs(transaction)
        .filter((job) => job.enabled)
        .sort((left, right) => (left.nextRunAt ?? '').localeCompare(right.nextRunAt ?? '')),
    );
  }

  public find(scope: CronJobScope, jobId: string): Promise<CronJob | undefined> {
    return this.#storage.transact((transaction) => {
      const job = transaction.get(JOBS, jobId, parseJob);
      return job !== undefined && inScope(job, scope) ? job : undefined;
    });
  }

  public insert(job: CronJob): Promise<void> {
    return this.#storage.transact((transaction) => {
      if (transaction.get(JOBS, job.jobId, parseJob) !== undefined) {
        throw new Error(`Cron job ${job.jobId} already exists.`);
      }
      transaction.set(JOBS, job.jobId, job);
    });
  }

  public interruptActive(now: Date): Promise<void> {
    return this.#storage.transact((transaction) => {
      const error = 'Nox stopped before this cron run completed.';
      for (const run of runs(transaction)) {
        if (run.status !== 'queued' && run.status !== 'running') continue;
        const interrupted: CronRun = {
          ...run,
          completedAt: now.toISOString(),
          error,
          status: 'interrupted',
        };
        transaction.set(RUNS, run.runId, interrupted);

        const job = transaction.get(JOBS, run.jobId, parseJob);
        if (job?.lastRunId !== run.runId) continue;
        transaction.set(JOBS, job.jobId, {
          ...job,
          lastError: error,
          lastStatus: 'interrupted',
          updatedAt: now.toISOString(),
        });
      }
    });
  }

  public list(
    scope: CronJobScope,
    options: { readonly enabled?: boolean; readonly limit: number },
  ): Promise<CronJob[]> {
    return this.#storage.transact((transaction) =>
      jobs(transaction)
        .filter(
          (job) =>
            inScope(job, scope) &&
            (options.enabled === undefined || job.enabled === options.enabled),
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, options.limit),
    );
  }

  public listRuns(jobId: string, limit: number): Promise<CronRun[]> {
    return this.#storage.transact((transaction) =>
      runs(transaction)
        .filter((run) => run.jobId === jobId)
        .sort((left, right) => right.scheduledFor.localeCompare(left.scheduledFor))
        .slice(0, limit),
    );
  }

  public replace(job: CronJob): Promise<void> {
    return this.#storage.transact((transaction) => {
      if (transaction.get(JOBS, job.jobId, parseJob) !== undefined) {
        transaction.set(JOBS, job.jobId, job);
      }
    });
  }

  public save(job: CronJob, run: CronRun): Promise<void> {
    return this.#storage.transact((transaction) => {
      if (transaction.get(JOBS, job.jobId, parseJob) === undefined) {
        throw new Error(`Cron job ${job.jobId} does not exist.`);
      }
      if (transaction.get(RUNS, run.runId, parseRun) !== undefined) {
        throw new Error(`Cron run ${run.runId} already exists.`);
      }
      transaction.set(JOBS, job.jobId, job);
      transaction.set(RUNS, run.runId, run);
    });
  }

  /** Updates one occurrence without replacing schedule edits made while it was running. */
  public updateRun(job: CronJob, run: CronRun): Promise<void> {
    return this.#storage.transact((transaction) => {
      if (transaction.get(RUNS, run.runId, parseRun) !== undefined) {
        transaction.set(RUNS, run.runId, run);
      }
      const current = transaction.get(JOBS, job.jobId, parseJob);
      if (current?.lastRunId !== run.runId) return;
      transaction.set(JOBS, current.jobId, {
        ...current,
        ...(job.lastError === undefined ? { lastError: undefined } : { lastError: job.lastError }),
        lastStatus: job.lastStatus,
        updatedAt: job.updatedAt,
      });
    });
  }
}

export { CronJobStore };
