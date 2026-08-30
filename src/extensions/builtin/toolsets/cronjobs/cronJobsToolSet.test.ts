import { describe, expect, test } from 'bun:test';

import { CronJobsToolSet } from './cronJobsToolSet';

import type {
  CreateCronJobInput,
  CronJob,
  CronJobPolicy,
  CronRun,
  CronRunSubmission,
} from './model';
import type { CronJobManager } from './scheduler';
import type {
  MessageContent,
  ScheduledRunDelivery,
  ToolExecution,
  ToolSessionContext,
} from '@nox/extension-api';

const SESSION = {
  agentId: 'author-agent',
  metadata: {},
  principal: { issuer: 'test', subject: 'alice' },
  sessionId: 'session-a',
} as const;

function job(input: CreateCronJobInput): CronJob {
  const now = new Date().toISOString();
  return {
    agentId: input.agentId,
    createdAt: now,
    createdFromSessionId: input.createdFromSessionId,
    ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
    enabled: true,
    jobId: 'cron_test',
    lastStatus: 'scheduled',
    name: input.name,
    nextRunAt: '2030-01-01T00:00:00.000Z',
    prompt: input.prompt,
    schedule:
      input.schedule.type === 'at'
        ? { at: input.schedule.at, type: 'at' }
        : {
            expression: input.schedule.expression,
            timeZone: input.schedule.timeZone ?? 'UTC',
            type: 'cron',
          },
    scope: input.scope,
    updatedAt: now,
  };
}

class RecordingManager implements CronJobManager {
  public created?: { input: CreateCronJobInput; policy: CronJobPolicy };

  public agents(): Promise<readonly string[]> {
    return Promise.resolve(['mail-agent', 'research-agent']);
  }

  public deliveryBrokers(): Promise<readonly string[]> {
    return Promise.resolve(['discord']);
  }

  public deliveryHere(sessionId: string): Promise<ScheduledRunDelivery | undefined> {
    return Promise.resolve(
      sessionId === 'session-on-discord'
        ? { brokerId: 'discord', channelId: 'channel-1' }
        : undefined,
    );
  }

  public create(
    input: CreateCronJobInput,
    policy: CronJobPolicy,
    _signal: AbortSignal,
  ): Promise<CronJob> {
    this.created = { input, policy };
    return Promise.resolve(job(input));
  }

  public delete(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public get(): Promise<CronJob | undefined> {
    return Promise.resolve(undefined);
  }

  public list(): Promise<readonly CronJob[]> {
    return Promise.resolve([]);
  }

  public listRuns(): Promise<readonly CronRun[]> {
    return Promise.resolve([]);
  }

  public runNow(): Promise<CronRunSubmission> {
    throw new Error('Not used by this test.');
  }

  public update(): Promise<CronJob> {
    throw new Error('Not used by this test.');
  }
}

async function output(
  execution: ToolExecution,
  session: ToolSessionContext = SESSION,
): Promise<MessageContent[]> {
  const result = await execution.run({
    abortSignal: new AbortController().signal,
    session,
    toolSetId: 'automation',
  });
  return 'ack' in result ? result.ack : result;
}

function textOf(content: MessageContent[]): string {
  const first = content[0];
  return first?.type === 'text' ? first.text : '';
}

describe('CronJobsToolSet', () => {
  test('declares agent discovery and every management tool with instance-level cuts', () => {
    const all = new CronJobsToolSet({ type: 'cronjobs' }, new RecordingManager());
    expect(Object.keys(all.tools)).toEqual([
      'cron_agents',
      'cron_create',
      'cron_delete',
      'cron_get',
      'cron_list',
      'cron_run',
      'cron_update',
    ]);

    const readOnly = new CronJobsToolSet(
      { enabledTools: ['cron_agents', 'cron_get', 'cron_list'], type: 'cronjobs' },
      new RecordingManager(),
    );
    expect(Object.keys(readOnly.tools)).toEqual(['cron_agents', 'cron_get', 'cron_list']);
  });

  test('selects an agent and channel while retaining only authoring-session audit', async () => {
    const manager = new RecordingManager();
    const toolSet = new CronJobsToolSet(
      { maxJobs: 7, type: 'cronjobs' },
      manager,
      'America/Mexico_City',
    );
    const execution = toolSet.prepare('cron_create', {
      agentId: 'mail-agent',
      delivery: { brokerId: 'discord', channelId: 'mail-alerts' },
      name: 'Morning brief',
      prompt: 'Prepare my brief.',
      schedule: { expression: '0 9 * * *', type: 'cron' },
    });

    const content = await output(execution);
    expect(content[0]?.type).toBe('text');
    expect(manager.created).toMatchObject({
      input: {
        agentId: 'mail-agent',
        createdFromSessionId: SESSION.sessionId,
        delivery: { brokerId: 'discord', channelId: 'mail-alerts' },
        name: 'Morning brief',
        prompt: 'Prepare my brief.',
        scope: { toolSetId: 'automation' },
      },
      policy: { maxJobs: 7, timeZone: 'America/Mexico_City' },
    });
  });

  test('lists configured agents through the host', async () => {
    const toolSet = new CronJobsToolSet({ type: 'cronjobs' }, new RecordingManager());
    const content = await output(toolSet.prepare('cron_agents', {}));
    expect(content[0]).toMatchObject({ type: 'text' });
    expect(textOf(content)).toContain('mail-agent');
    expect(textOf(content)).toContain('discord');
  });

  test('names the channel this conversation is already on, and omits it when there is none', async () => {
    const toolSet = new CronJobsToolSet({ type: 'cronjobs' }, new RecordingManager());

    const onDiscord = await output(toolSet.prepare('cron_agents', {}), {
      ...SESSION,
      sessionId: 'session-on-discord',
    });
    expect(JSON.parse(textOf(onDiscord))).toMatchObject({
      deliveryHere: { brokerId: 'discord', channelId: 'channel-1' },
    });

    // A session no transport owns offers no address. The absence is the point:
    // it is what stops the answer from being a channel ID that was made up.
    const headless = await output(toolSet.prepare('cron_agents', {}));
    expect(JSON.parse(textOf(headless))).not.toHaveProperty('deliveryHere');
  });

  test('rejects malformed expressions, missing agent IDs, and per-job non-IANA zones', () => {
    const toolSet = new CronJobsToolSet({ type: 'cronjobs' }, new RecordingManager());
    expect(() =>
      toolSet.prepare('cron_create', {
        agentId: 'mail-agent',
        name: 'Broken',
        prompt: 'Never.',
        schedule: { expression: 'sometimes', type: 'cron' },
      }),
    ).toThrow('Invalid params');
    expect(() =>
      toolSet.prepare('cron_create', {
        name: 'No agent',
        prompt: 'Never.',
        schedule: { at: '2030-01-01T00:00:00Z', type: 'at' },
      }),
    ).toThrow('Invalid params');
    expect(() =>
      toolSet.prepare('cron_create', {
        agentId: 'mail-agent',
        name: 'Wrong zone',
        prompt: 'Never.',
        schedule: { expression: '0 9 * * *', timeZone: 'Mars/Olympus', type: 'cron' },
      }),
    ).toThrow('Invalid params');
  });

  test('requires a host-bound session only to audit who authored the job', () => {
    const toolSet = new CronJobsToolSet({ type: 'cronjobs' }, new RecordingManager());
    const execution = toolSet.prepare('cron_create', {
      agentId: 'mail-agent',
      name: 'Detached',
      prompt: 'No author.',
      schedule: { at: '2030-01-01T00:00:00Z', type: 'at' },
    });

    expect(
      execution.run({
        abortSignal: new AbortController().signal,
        toolSetId: 'automation',
      }),
    ).rejects.toThrow('host-bound session');
  });
});
