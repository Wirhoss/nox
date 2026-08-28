import { brokers, contributionInstances } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import { NoxApplication } from '../../../../application';
import { bindExtensionManifest } from '../../../extension';
import { discordBrokerExtension } from './extension';

async function started(): Promise<NoxApplication> {
  const app = new NoxApplication({
    extensions: [
      bindExtensionManifest(
        {
          engines: { extensionApi: '*', nox: '*' },
          id: 'nox.broker.discord',
          main: 'extension.js',
          schemaVersion: 1,
          version: '0.1.0',
        },
        discordBrokerExtension,
      ),
    ],
  });
  await app.start();
  return app;
}

describe('discordBrokerExtension', () => {
  test('contributes one broker under the ID it owns', async () => {
    const app = await started();
    const contribution = app.contributions.get(brokers, 'discord');

    expect(contribution?.extensionId).toBe('nox.broker.discord');
    expect(contribution?.value.configSchema.shape.type.value).toBe('discord');
    expect(contribution === undefined ? undefined : contributionInstances(contribution.value)).toBe(
      'single',
    );

    await app.stop();
  });
});
