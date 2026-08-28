import { brokers, contributionInstances } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import { NoxApplication } from '../../../../application';
import { bindExtensionManifest } from '../../../extension';
import { discordBrokerConfigSchema } from './config';
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
  test('refuses to build when the token secret has no stored value', async () => {
    const app = await started();
    const contribution = app.contributions.get(brokers, 'discord');
    const entry = discordBrokerConfigSchema.parse({
      agent: 'assistant',
      applicationId: '123456789012345678',
      token: { $secret: 'DISCORD_BOT_TOKEN' },
      type: 'discord',
    });
    // What an unresolved secret leaves behind: the key is gone, not set to
    // `undefined`, because an optional field has to read as absent to its own
    // schema. The type still claims a handle is there.
    const { token: _dropped, ...resolved } = entry;

    // Throwing here is the whole point: `composeWithSecrets` only gets to name
    // the missing secret if the contribution rejects what it was handed, and
    // the reconcile loop only gets to mark this broker unavailable — and leave
    // the rest of Nox running — if the failure happens at build time rather
    // than inside a websocket listener later.
    expect(() =>
      contribution?.value.create(
        resolved as unknown as Parameters<typeof contribution.value.create>[0],
      ),
    ).toThrow();

    await app.stop();
  });

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
