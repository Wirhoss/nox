import { describe, expect, test } from 'bun:test';

import { NoxApplication } from '../../../../application';
import { authorities } from '../../../contribution-points/authorities';
import { translationFragments } from '../../../contribution-points/languages';
import { toolSets } from '../../../contribution-points/toolsets';
import { CronJobsToolSet } from './cronJobsToolSet';
import { cronJobsExtension } from './extension';

async function started(): Promise<NoxApplication> {
  const app = new NoxApplication({ extensions: [cronJobsExtension] });
  await app.start();
  return app;
}

describe('cronJobsExtension', () => {
  test('contributes its schema and three separate authorities', async () => {
    const app = await started();
    try {
      const contribution = app.contributions.get(toolSets, 'cronjobs');
      expect(contribution?.extensionId).toBe('nox.toolset.cronjobs');
      expect(contribution?.value.configSchema).toBe(CronJobsToolSet.configSchema);
      expect(Object.keys(CronJobsToolSet.configSchema.shape)).toEqual([
        'enabledTools',
        'maxJobs',
        'type',
      ]);
      expect(contribution?.value.configSchema.shape.type.value).toBe('cronjobs');
      expect(app.contributions.list(authorities).map((entry) => entry.id)).toEqual([
        'nox.toolset.cronjobs.read',
        'nox.toolset.cronjobs.write',
        'nox.toolset.cronjobs.run',
      ]);
    } finally {
      await app.stop();
    }
  });

  test('owns matching English and Spanish settings copy', async () => {
    const app = await started();
    try {
      const english = app.contributions.get(translationFragments, 'nox.toolset.cronjobs.en');
      const spanish = app.contributions.get(translationFragments, 'nox.toolset.cronjobs.es');
      expect(english?.value.namespace).toBe('nox.toolset.cronjobs');
      expect(spanish?.value.namespace).toBe('nox.toolset.cronjobs');
      expect(Object.keys(spanish?.value.messages ?? {}).sort()).toEqual(
        Object.keys(english?.value.messages ?? {}).sort(),
      );
    } finally {
      await app.stop();
    }
  });

  test('disposes every contribution without requiring scheduler services', async () => {
    const app = await started();
    await app.stop();
    expect(app.contributions.has(toolSets, 'cronjobs')).toBe(false);
  });
});
