import { ToolSet, toolSetBaseConfigSchema, z } from '@nox/extension-api';

import { cronTools } from './tools';

import type { CronJobPolicy } from './model';
import type { CronJobManager } from './scheduler';

const cronJobsConfigSchema = toolSetBaseConfigSchema.extend({
  maxJobs: z
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(100)
    .meta({ nox: { help: 'ui.maxJobsHelp', label: 'ui.maxJobs' } }),
  type: z.literal('cronjobs'),
});

type CronJobsConfig = z.infer<typeof cronJobsConfigSchema>;
type CronJobsConfigInput = z.input<typeof cronJobsConfigSchema>;

function policyFrom(config: CronJobsConfig, appTimeZone: string): CronJobPolicy {
  return Object.freeze({ maxJobs: config.maxJobs, timeZone: appTimeZone });
}

class CronJobsToolSet extends ToolSet {
  static readonly configSchema = cronJobsConfigSchema;

  readonly #manager: CronJobManager;
  readonly #policy: CronJobPolicy;

  constructor(input: CronJobsConfigInput, manager: CronJobManager, appTimeZone = 'UTC') {
    const config = cronJobsConfigSchema.parse(input);
    super(
      'Cron jobs',
      'Run persistent schedules in fresh sessions of selected configured agents.',
      config.enabledTools,
    );
    this.#manager = manager;
    this.#policy = policyFrom(config, appTimeZone);
    this.addTools();
  }

  protected override addTools(): void {
    for (const tool of cronTools(this.#manager, this.#policy)) this.registerTool(tool);
  }
}

export { cronJobsConfigSchema, CronJobsToolSet, policyFrom };

export type { CronJobsConfig, CronJobsConfigInput };
