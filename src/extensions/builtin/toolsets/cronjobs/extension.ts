import {
  authorities,
  configService,
  defineExtension,
  defineTranslationFragment,
  scheduledRunHostService,
  toolSetContribution,
  toolSets,
  translationFragments,
} from '@nox/extension-api';

import { cronJobsConfigSchema, CronJobsToolSet, policyFrom } from './cronJobsToolSet';
import { englishMessages } from './messages';
import { spanishMessages } from './messages.es';
import { CronScheduler } from './scheduler';
import { CronJobStore } from './store';
import { CRON_READ_AUTHORITY, CRON_RUN_AUTHORITY, CRON_WRITE_AUTHORITY } from './tools';

/** Contributes persistent scheduled prompts and the timer wheel that submits them. */
const cronJobsExtension = defineExtension({
  activate(context) {
    context.contributions.register(
      translationFragments,
      'nox.toolset.cronjobs.en',
      defineTranslationFragment({
        locale: 'en',
        messages: englishMessages,
        namespace: 'nox.toolset.cronjobs',
      }),
    );
    context.contributions.register(
      translationFragments,
      'nox.toolset.cronjobs.es',
      defineTranslationFragment({
        locale: 'es',
        messages: spanishMessages,
        namespace: 'nox.toolset.cronjobs',
      }),
    );

    context.contributions.register(authorities, CRON_READ_AUTHORITY, {
      description: 'Read scheduled jobs owned by the current conversation.',
    });
    context.contributions.register(authorities, CRON_WRITE_AUTHORITY, {
      description: 'Create, change, pause, resume, and delete scheduled jobs.',
    });
    context.contributions.register(authorities, CRON_RUN_AUTHORITY, {
      description: 'Submit a scheduled job for immediate execution.',
    });

    let scheduler: CronScheduler | undefined;
    const manager = (): CronScheduler => {
      if (scheduler !== undefined) return scheduler;

      const config = context.services.get(configService);
      scheduler = context.subscriptions.add(
        new CronScheduler({
          host: context.services.get(scheduledRunHostService),
          logger: context.logger,
          policyFor: (toolSetId) => {
            const entry = config.get('toolSets')[toolSetId];
            const parsed = cronJobsConfigSchema.safeParse(entry);
            return parsed.success ? policyFrom(parsed.data, config.get('app').timezone) : undefined;
          },
          store: new CronJobStore(context.storage),
        }),
      );
      void scheduler.start().catch((error: unknown) => {
        context.logger.error({ err: error }, 'Cron scheduler could not start.');
      });
      return scheduler;
    };

    context.contributions.register(
      toolSets,
      'cronjobs',
      toolSetContribution({
        configSchema: CronJobsToolSet.configSchema,
        create: (config) =>
          new CronJobsToolSet(
            config,
            manager(),
            context.services.get(configService).get('app').timezone,
          ),
      }),
    );
  },
});

export default cronJobsExtension;
export { cronJobsExtension };
