import { authorities, toolSets, translationFragments } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import { NoxApplication } from '../../../../application';
import { bindExtensionManifest } from '../../../extension';
import { ConfigToolSet } from './configToolSet';
import { configToolsExtension } from './extension';

async function started(): Promise<NoxApplication> {
  const app = new NoxApplication({
    extensions: [
      bindExtensionManifest(
        {
          engines: { extensionApi: '*', nox: '*' },
          id: 'nox.toolset.config',
          main: 'extension.js',
          schemaVersion: 1,
          version: '0.1.0',
        },
        configToolsExtension,
      ),
    ],
  });
  await app.start();
  return app;
}

describe('configToolsExtension', () => {
  test('contributes its schema and separate read, write, and runtime authorities', async () => {
    const app = await started();
    try {
      const contribution = app.contributions.get(toolSets, 'config');
      expect(contribution?.extensionId).toBe('nox.toolset.config');
      expect(contribution?.value.configSchema).toBe(ConfigToolSet.configSchema);
      expect(Object.keys(ConfigToolSet.configSchema.shape)).toEqual([
        'enabledTools',
        'manageRuntime',
        'readSecretMetadata',
        'readSections',
        'type',
        'writeSections',
      ]);
      expect(ConfigToolSet.configSchema.shape.type.value).toBe('config');
      expect(app.contributions.list(authorities).map((entry) => entry.id)).toEqual([
        'nox.toolset.config.read',
        'nox.toolset.config.write',
        'nox.toolset.config.runtime',
      ]);
    } finally {
      await app.stop();
    }
  });

  test('owns matching English and Spanish settings copy', async () => {
    const app = await started();
    try {
      const english = app.contributions.get(translationFragments, 'nox.toolset.config.en');
      const spanish = app.contributions.get(translationFragments, 'nox.toolset.config.es');
      expect(english?.value.namespace).toBe('nox.toolset.config');
      expect(spanish?.value.namespace).toBe('nox.toolset.config');
      expect(Object.keys(spanish?.value.messages ?? {}).sort()).toEqual(
        Object.keys(english?.value.messages ?? {}).sort(),
      );
    } finally {
      await app.stop();
    }
  });

  test('does not require host services until a configured instance is composed', async () => {
    const app = await started();
    await app.stop();
    expect(app.contributions.has(toolSets, 'config')).toBe(false);
  });
});
