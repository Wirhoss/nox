import { z } from 'zod';

import { stableStringify } from '../../../../utils/json';
import {
  cronDeliverySchema,
  type CronJobPolicy,
  type CronJobScope,
  cronScheduleInputSchema,
} from './model';

import type { Tool, ToolContext } from '../../../../tool/tool';
import type { CronJobManager } from './scheduler';

const CRON_READ_AUTHORITY = 'nox.toolset.cronjobs.read';
const CRON_WRITE_AUTHORITY = 'nox.toolset.cronjobs.write';
const CRON_RUN_AUTHORITY = 'nox.toolset.cronjobs.run';

const agentIdSchema = z.string().trim().min(1).max(100).describe('Configured agent ID.');
const jobIdSchema = z.string().trim().min(1).max(100).describe('Cron job ID.');
const nameSchema = z.string().trim().min(1).max(120).describe('Short human-readable job name.');
const promptSchema = z
  .string()
  .trim()
  .min(1)
  .max(20_000)
  .describe('Prompt given to a fresh session whenever the job runs.');

interface InvocationScope {
  readonly createdFromSessionId: string;
  readonly scope: CronJobScope;
}

function invocation(ctx: ToolContext): InvocationScope {
  const session = ctx.session;
  const toolSetId = ctx.toolSetId;
  if (session === undefined || toolSetId === undefined) {
    throw new Error('Cron tools require a host-bound session and tool-set identity.');
  }
  return {
    createdFromSessionId: session.sessionId,
    scope: { toolSetId },
  };
}

function text(value: unknown): [{ readonly text: string; readonly type: 'text' }] {
  return [{ text: stableStringify(value), type: 'text' }];
}

function cronTools(manager: CronJobManager, policy: CronJobPolicy): readonly Tool[] {
  const agentsParameters = z.object({});
  const agents: Tool<typeof agentsParameters> = {
    authority: CRON_READ_AUTHORITY,
    description: 'List configured agents and brokers available to cron jobs.',
    name: 'cron_agents',
    parameters: agentsParameters,
    prepare: () => ({
      run: async (ctx) => {
        const [agentIds, deliveryBrokerIds] = await Promise.all([
          manager.agents(ctx.abortSignal),
          manager.deliveryBrokers(ctx.abortSignal),
        ]);
        return text({ agentIds, deliveryBrokerIds });
      },
      title: 'List cron agents',
      type: 'immediate',
    }),
    risk: { effects: ['read'], reversible: true },
  };

  const createParameters = z.object({
    agentId: agentIdSchema,
    delivery: cronDeliverySchema
      .optional()
      .describe('Optional broker channel that receives the final response.'),
    name: nameSchema,
    prompt: promptSchema,
    schedule: cronScheduleInputSchema.describe(
      'Either one future ISO 8601 instant or a recurring five-field cron expression.',
    ),
  });
  const create: Tool<typeof createParameters> = {
    authority: CRON_WRITE_AUTHORITY,
    description: 'Create a persistent job that starts a fresh configured-agent session.',
    name: 'cron_create',
    parameters: createParameters,
    prepare: (params) => ({
      risk: {
        effects: ['write'],
        resources: [{ kind: 'command', value: `cron:${params.name}` }],
        reversible: true,
      },
      run: async (ctx) => {
        ctx.abortSignal.throwIfAborted();
        const owner = invocation(ctx);
        const job = await manager.create({ ...params, ...owner }, policy, ctx.abortSignal);
        return text({ job });
      },
      title: `Create cron job — ${params.name}`,
      type: 'immediate',
    }),
    risk: { effects: ['write'], reversible: true },
  };

  const listParameters = z.object({
    enabled: z.boolean().optional().describe('Filter by enabled state.'),
    limit: z.number().int().min(1).max(100).default(50).describe('Maximum jobs to return.'),
  });
  const list: Tool<typeof listParameters> = {
    authority: CRON_READ_AUTHORITY,
    description: 'List jobs owned by this cron tool-set instance.',
    name: 'cron_list',
    parameters: listParameters,
    prepare: (params) => ({
      run: async (ctx) => {
        ctx.abortSignal.throwIfAborted();
        const jobs = await manager.list(invocation(ctx).scope, params);
        return text({ count: jobs.length, jobs });
      },
      title: 'List cron jobs',
      type: 'immediate',
    }),
    risk: { effects: ['read'], reversible: true },
  };

  const getParameters = z.object({
    jobId: jobIdSchema,
    runLimit: z.number().int().min(0).max(100).default(10),
  });
  const get: Tool<typeof getParameters> = {
    authority: CRON_READ_AUTHORITY,
    description: 'Read one cron job and its most recent independent runs.',
    name: 'cron_get',
    parameters: getParameters,
    prepare: (params) => ({
      run: async (ctx) => {
        ctx.abortSignal.throwIfAborted();
        const scope = invocation(ctx).scope;
        const job = await manager.get(scope, params.jobId);
        if (job === undefined) throw new Error(`Cron job "${params.jobId}" was not found.`);
        const runs =
          params.runLimit === 0 ? [] : await manager.listRuns(scope, params.jobId, params.runLimit);
        return text({ job, runs });
      },
      title: `Read cron job — ${params.jobId}`,
      type: 'immediate',
    }),
    risk: { effects: ['read'], reversible: true },
  };

  const updateParameters = z
    .object({
      agentId: agentIdSchema.optional(),
      delivery: cronDeliverySchema
        .nullable()
        .optional()
        .describe('New output channel; null removes delivery.'),
      enabled: z.boolean().optional().describe('Pause or resume future scheduled runs.'),
      jobId: jobIdSchema,
      name: nameSchema.optional(),
      prompt: promptSchema.optional(),
      schedule: cronScheduleInputSchema.optional(),
    })
    .refine(
      (input) =>
        input.agentId !== undefined ||
        input.delivery !== undefined ||
        input.enabled !== undefined ||
        input.name !== undefined ||
        input.prompt !== undefined ||
        input.schedule !== undefined,
      'Change at least one field.',
    );
  const update: Tool<typeof updateParameters> = {
    authority: CRON_WRITE_AUTHORITY,
    description: 'Change the agent, delivery, schedule, prompt, or enabled state of a cron job.',
    name: 'cron_update',
    parameters: updateParameters,
    prepare: ({ jobId, ...changes }) => ({
      risk: {
        effects: ['write'],
        resources: [{ kind: 'command', value: `cron:${jobId}` }],
        reversible: true,
      },
      run: async (ctx) => {
        ctx.abortSignal.throwIfAborted();
        return text({
          job: await manager.update(invocation(ctx).scope, jobId, changes, policy, ctx.abortSignal),
        });
      },
      title: `Update cron job — ${jobId}`,
      type: 'immediate',
    }),
    risk: { effects: ['write'], reversible: true },
  };

  const deleteParameters = z.object({ jobId: jobIdSchema });
  const remove: Tool<typeof deleteParameters> = {
    authority: CRON_WRITE_AUTHORITY,
    description: 'Permanently delete a cron job and its run history.',
    name: 'cron_delete',
    parameters: deleteParameters,
    prepare: (params) => ({
      risk: {
        effects: ['delete'],
        resources: [{ kind: 'command', value: `cron:${params.jobId}` }],
        reversible: false,
      },
      run: async (ctx) => {
        ctx.abortSignal.throwIfAborted();
        const deleted = await manager.delete(invocation(ctx).scope, params.jobId);
        return text({ deleted, jobId: params.jobId });
      },
      title: `Delete cron job — ${params.jobId}`,
      type: 'immediate',
    }),
    risk: { effects: ['delete'], reversible: false },
  };

  const runParameters = z.object({ jobId: jobIdSchema });
  const run: Tool<typeof runParameters> = {
    authority: CRON_RUN_AUTHORITY,
    description: 'Queue a fresh agent session immediately without changing the future schedule.',
    name: 'cron_run',
    parameters: runParameters,
    prepare: (params) => ({
      risk: {
        effects: ['execute'],
        resources: [{ kind: 'command', value: `cron:${params.jobId}` }],
        reversible: false,
      },
      run: async (ctx) => {
        ctx.abortSignal.throwIfAborted();
        return text(await manager.runNow(invocation(ctx).scope, params.jobId));
      },
      title: `Run cron job — ${params.jobId}`,
      type: 'immediate',
    }),
    risk: { effects: ['execute'], reversible: false },
  };

  return [agents, create, list, get, update, remove, run];
}

export { CRON_READ_AUTHORITY, CRON_RUN_AUTHORITY, CRON_WRITE_AUTHORITY, cronTools };
