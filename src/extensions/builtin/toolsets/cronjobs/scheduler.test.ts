import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { Database } from '../../../../database/database';
import { silentLogger } from '../../../../logger/logger';
import { DatabaseExtensionStorageProvider } from '../../../storage';
import { CronScheduler } from './scheduler';
import { CronJobStore } from './store';

import type { CronJob, CronJobPolicy } from './model';
import type {
  ExtensionStorage,
  ScheduledRunHost,
  ScheduledRunRequest,
  ScheduledRunResult,
} from '@nox/extension-api';

const POLICY: CronJobPolicy = { maxJobs: 10, timeZone: 'America/Mexico_City' };

const SCOPE = { toolSetId: 'automation' } as const;

class RecordingHost implements ScheduledRunHost {
  public readonly requests: ScheduledRunRequest[] = [];

  public agentIds(): Promise<readonly string[]> {
    return Promise.resolve(['mail-agent', 'research-agent']);
  }

  public deliveryBrokerIds(): Promise<readonly string[]> {
    return Promise.resolve(['discord']);
  }

  public runScheduledAgent(request: ScheduledRunRequest): Promise<ScheduledRunResult> {
    this.requests.push(request);
    const now = new Date();
    return Promise.resolve({
      completedAt: now,
      content: [{ text: `completed by ${request.agentId}`, type: 'text' }],
      ...(request.delivery === undefined ? {} : { deliveredAt: now }),
      runId: `agent_${request.causeId}`,
      sessionId: request.sessionId,
      startedAt: now,
      status: 'completed',
    });
  }
}

class BlockingHost extends RecordingHost {
  #finish?: () => void;

  public override runScheduledAgent(request: ScheduledRunRequest): Promise<ScheduledRunResult> {
    this.requests.push(request);
    return new Promise((resolve) => {
      this.#finish = () => {
        const now = new Date();
        resolve({
          completedAt: now,
          content: [{ text: `completed by ${request.agentId}`, type: 'text' }],
          runId: `agent_${request.causeId}`,
          sessionId: request.sessionId,
          startedAt: now,
          status: 'completed',
        });
      };
    });
  }

  public finish(): void {
    const finish = this.#finish;
    if (finish === undefined) throw new Error('No cron run is waiting.');
    this.#finish = undefined;
    finish();
  }
}

interface Harness {
  readonly database: Database;
  readonly directory: string;
  readonly host: RecordingHost;
  readonly scheduler: CronScheduler;
  readonly storage: ExtensionStorage;
  readonly store: CronJobStore;
}

async function harness(host = new RecordingHost()): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'nox-cron-'));
  const database = await Database.open({ path: join(directory, 'nox.db') });
  const storage = new DatabaseExtensionStorageProvider(database).forExtension(
    'nox.toolset.cronjobs',
  );
  const store = new CronJobStore(storage);
  const scheduler = new CronScheduler({
    host,
    logger: silentLogger,
    policyFor: (toolSetId) => (toolSetId === SCOPE.toolSetId ? POLICY : undefined),
    store,
  });
  return { database, directory, host, scheduler, storage, store };
}

function removeDirectory(directory: string): void {
  try {
    rmSync(directory, { force: true, recursive: true });
  } catch {
    // Windows may retain a closed SQLite handle briefly; the temp path is disposable.
  }
}

async function close(state: Harness): Promise<void> {
  await state.scheduler.dispose();
  await state.database.close();
  removeDirectory(state.directory);
}

function future(milliseconds = 60_000): string {
  return new Date(Date.now() + milliseconds).toISOString();
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for scheduled job.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createJob(state: Harness, at = future(60_000)) {
  return state.scheduler.create(
    {
      agentId: 'mail-agent',
      createdFromSessionId: 'authoring-session',
      delivery: { brokerId: 'discord', channelId: 'alerts' },
      name: 'Mail summary',
      prompt: 'Read new mail and report important messages.',
      schedule: { at, type: 'at' },
      scope: SCOPE,
    },
    POLICY,
    new AbortController().signal,
  );
}

describe('CronScheduler', () => {
  test('targets a configured agent and runs every occurrence in a fresh session', async () => {
    const state = await harness();
    try {
      const created = await state.scheduler.create(
        {
          agentId: 'mail-agent',
          createdFromSessionId: 'authoring-session',
          delivery: { brokerId: 'discord', channelId: 'alerts' },
          name: 'Daily summary',
          prompt: 'Summarize new mail.',
          schedule: { expression: '0 9 * * *', type: 'cron' },
          scope: SCOPE,
        },
        POLICY,
        new AbortController().signal,
      );
      expect(created.schedule).toEqual({
        expression: '0 9 * * *',
        timeZone: 'America/Mexico_City',
        type: 'cron',
      });
      const scheduledFor = created.nextRunAt;
      const first = await state.scheduler.runNow(SCOPE, created.jobId);
      await waitUntil(
        async () => (await state.store.listRuns(created.jobId, 10))[0]?.status === 'completed',
      );
      const second = await state.scheduler.runNow(SCOPE, created.jobId);
      await waitUntil(() => state.host.requests.length === 2);

      expect(first.job.nextRunAt).toBe(scheduledFor);
      expect(second.job.nextRunAt).toBe(scheduledFor);
      expect(state.host.requests.map((request) => request.agentId)).toEqual([
        'mail-agent',
        'mail-agent',
      ]);
      expect(new Set(state.host.requests.map((request) => request.sessionId)).size).toBe(2);
      expect(state.host.requests[0]).toMatchObject({
        delivery: { brokerId: 'discord', channelId: 'alerts' },
      });
      const runs = await state.store.listRuns(created.jobId, 10);
      expect(runs[0]).toMatchObject({
        output: [{ text: 'completed by mail-agent', type: 'text' }],
        status: 'completed',
      });
      expect(runs[0]?.sessionId).not.toBe('authoring-session');
    } finally {
      await close(state);
    }
  });

  test('keeps edits made while an independent run is still active', async () => {
    const host = new BlockingHost();
    const state = await harness(host);
    try {
      const created = await createJob(state);
      await state.scheduler.runNow(SCOPE, created.jobId);
      await waitUntil(() => host.requests.length === 1);

      await state.scheduler.update(
        SCOPE,
        created.jobId,
        { agentId: 'research-agent', prompt: 'Use the revised prompt.' },
        POLICY,
        new AbortController().signal,
      );
      host.finish();
      await waitUntil(
        async () => (await state.store.listRuns(created.jobId, 1))[0]?.status === 'completed',
      );

      expect(await state.scheduler.get(SCOPE, created.jobId)).toMatchObject({
        agentId: 'research-agent',
        lastStatus: 'completed',
        prompt: 'Use the revised prompt.',
      });
      expect(host.requests[0]?.agentId).toBe('mail-agent');
    } finally {
      await close(state);
    }
  });

  test('fires a one-time job once and retains its independent run history', async () => {
    const state = await harness();
    try {
      const created = await createJob(state, future(500));

      await waitUntil(() => state.host.requests.length === 1);
      await waitUntil(
        async () => (await state.store.listRuns(created.jobId, 1))[0]?.status === 'completed',
      );
      const settled = await state.scheduler.get(SCOPE, created.jobId);
      expect(settled).toMatchObject({ enabled: false, lastStatus: 'completed' });
      expect(settled?.nextRunAt).toBeUndefined();
      expect(await state.scheduler.listRuns(SCOPE, created.jobId, 10)).toHaveLength(1);
    } finally {
      await close(state);
    }
  });

  test('re-arms a persisted future job during startup without a management call', async () => {
    const state = await harness();
    let replacement: CronScheduler | undefined;
    try {
      await createJob(state, future(500));
      await state.scheduler.dispose();

      replacement = new CronScheduler({
        host: state.host,
        logger: silentLogger,
        policyFor: () => POLICY,
        store: state.store,
      });
      await replacement.start();

      await waitUntil(() => state.host.requests.length === 1);
      expect(state.host.requests[0]?.prompt).toBe('Read new mail and report important messages.');
    } finally {
      await replacement?.dispose();
      await state.database.close();
      removeDirectory(state.directory);
    }
  });

  test('marks an unfinished persisted occurrence interrupted instead of rerunning it', async () => {
    const state = await harness();
    let replacement: CronScheduler | undefined;
    try {
      const created = await createJob(state);
      await state.scheduler.dispose();
      const now = new Date().toISOString();
      const run = {
        agentId: created.agentId,
        createdAt: now,
        jobId: created.jobId,
        runId: 'cronrun_interrupted',
        scheduledFor: now,
        sessionId: 'cron_session_interrupted',
        startedAt: now,
        status: 'running' as const,
      };
      await state.store.save(
        { ...created, lastRunId: run.runId, lastStatus: 'running', updatedAt: now },
        run,
      );

      replacement = new CronScheduler({
        host: state.host,
        logger: silentLogger,
        policyFor: () => POLICY,
        store: state.store,
      });
      await replacement.start();

      const [interrupted] = await state.store.listRuns(created.jobId, 1);
      expect(interrupted).toMatchObject({ status: 'interrupted' });
      expect(interrupted?.error).toContain('stopped');
      expect(await state.store.find(SCOPE, created.jobId)).toMatchObject({
        lastStatus: 'interrupted',
      });
      expect(state.host.requests).toHaveLength(0);
    } finally {
      await replacement?.dispose();
      await state.database.close();
      removeDirectory(state.directory);
    }
  });

  test('records but does not replay a one-time occurrence missed while stopped', async () => {
    const state = await harness();
    let replacement: CronScheduler | undefined;
    try {
      const created = await createJob(state);
      await state.scheduler.dispose();

      const past = new Date(Date.now() - 60_000).toISOString();
      await state.storage.transact((transaction) => {
        const job = transaction.get('jobs', created.jobId, (value) => value as CronJob);
        if (job === undefined) throw new Error('Expected the persisted cron job.');
        transaction.set('jobs', job.jobId, {
          ...job,
          nextRunAt: past,
          schedule: { at: past, type: 'at' },
        });
      });

      replacement = new CronScheduler({
        host: state.host,
        logger: silentLogger,
        policyFor: () => POLICY,
        store: state.store,
      });
      await replacement.start();
      const normalized = await state.store.find(SCOPE, created.jobId);
      const [missed] = await state.store.listRuns(created.jobId, 10);
      expect(normalized).toMatchObject({ enabled: false, lastStatus: 'skipped' });
      expect(missed).toMatchObject({ status: 'skipped' });
      expect(missed?.error).toContain('missed');
      expect(state.host.requests).toHaveLength(0);
    } finally {
      await replacement?.dispose();
      await state.database.close();
      removeDirectory(state.directory);
    }
  });

  test('skips one missed recurring occurrence and schedules only the next future one', async () => {
    const state = await harness();
    let replacement: CronScheduler | undefined;
    try {
      const created = await state.scheduler.create(
        {
          agentId: 'research-agent',
          createdFromSessionId: 'authoring-session',
          name: 'Recurring',
          prompt: 'Do not catch up.',
          schedule: { expression: '* * * * *', type: 'cron' },
          scope: SCOPE,
        },
        POLICY,
        new AbortController().signal,
      );
      await state.scheduler.dispose();

      await state.storage.transact((transaction) => {
        const job = transaction.get('jobs', created.jobId, (value) => value as CronJob);
        if (job === undefined) throw new Error('Expected the persisted cron job.');
        transaction.set('jobs', job.jobId, {
          ...job,
          nextRunAt: new Date(Date.now() - 120_000).toISOString(),
        });
      });

      replacement = new CronScheduler({
        host: state.host,
        logger: silentLogger,
        policyFor: () => POLICY,
        store: state.store,
      });
      await replacement.start();

      const normalized = await state.store.find(SCOPE, created.jobId);
      expect(normalized).toMatchObject({ enabled: true, lastStatus: 'skipped' });
      expect(new Date(normalized?.nextRunAt ?? 0).getTime()).toBeGreaterThan(Date.now());
      expect(await state.store.listRuns(created.jobId, 10)).toHaveLength(1);
      expect(state.host.requests).toHaveLength(0);
    } finally {
      await replacement?.dispose();
      await state.database.close();
      removeDirectory(state.directory);
    }
  });

  test('rejects unknown agents, past dates, and the configured global tool-set limit', async () => {
    const state = await harness();
    try {
      expect(
        state.scheduler.create(
          {
            agentId: 'missing-agent',
            createdFromSessionId: 'authoring-session',
            name: 'Wrong agent',
            prompt: 'Impossible.',
            schedule: { at: future(), type: 'at' },
            scope: SCOPE,
          },
          POLICY,
          new AbortController().signal,
        ),
      ).rejects.toThrow('Available');

      expect(
        state.scheduler.create(
          {
            agentId: 'mail-agent',
            createdFromSessionId: 'authoring-session',
            delivery: { brokerId: 'missing-broker', channelId: 'alerts' },
            name: 'Wrong broker',
            prompt: 'Impossible.',
            schedule: { at: future(), type: 'at' },
            scope: SCOPE,
          },
          POLICY,
          new AbortController().signal,
        ),
      ).rejects.toThrow('Broker');

      expect(
        state.scheduler.create(
          {
            agentId: 'mail-agent',
            createdFromSessionId: 'authoring-session',
            name: 'Past',
            prompt: 'Impossible.',
            schedule: { at: new Date(Date.now() - 1_000).toISOString(), type: 'at' },
            scope: SCOPE,
          },
          POLICY,
          new AbortController().signal,
        ),
      ).rejects.toThrow('future');

      const limited = { ...POLICY, maxJobs: 1 };
      await createJob(state);
      expect(
        state.scheduler.create(
          {
            agentId: 'mail-agent',
            createdFromSessionId: 'another-session',
            name: 'Too many',
            prompt: 'Two.',
            schedule: { at: future(), type: 'at' },
            scope: SCOPE,
          },
          limited,
          new AbortController().signal,
        ),
      ).rejects.toThrow('limit');
    } finally {
      await close(state);
    }
  });
});
