import { memories, translationFragments } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import { NoxApplication } from '../../../../application';
import { bindExtensionManifest } from '../../../extension';
import { localMemoryExtension } from './extension';
import { LocalMemory } from './localMemory';

async function started(): Promise<NoxApplication> {
  const app = new NoxApplication({
    extensions: [
      bindExtensionManifest(
        {
          engines: { extensionApi: '*', nox: '*' },
          id: 'nox.memory.local',
          main: 'extension.js',
          schemaVersion: 1,
          version: '0.1.0',
        },
        localMemoryExtension,
      ),
    ],
  });
  await app.start();
  return app;
}

describe('localMemoryExtension', () => {
  test('contributes the one local memory instance backed by its Nox storage', async () => {
    const app = await started();

    const contribution = app.contributions.get(memories, 'local');
    const config = LocalMemory.configSchema.parse({ type: 'local' });
    const engine = contribution?.value.create(config);

    expect(contribution?.extensionId).toBe('nox.memory.local');
    expect(contribution?.value.instances).toBeUndefined();
    expect(contribution?.value.configSchema).toBe(LocalMemory.configSchema);
    expect(engine).toBeInstanceOf(LocalMemory);
    await app.stop();
  });

  test('owns matching English and Spanish settings copy', async () => {
    const app = await started();

    const english = app.contributions.get(translationFragments, 'nox.memory.local.en');
    const spanish = app.contributions.get(translationFragments, 'nox.memory.local.es');

    expect(english?.extensionId).toBe('nox.memory.local');
    expect(english?.value.namespace).toBe('nox.memory.local');
    expect(spanish?.extensionId).toBe('nox.memory.local');
    expect(spanish?.value.namespace).toBe('nox.memory.local');
    expect(Object.keys(spanish?.value.messages ?? {}).sort()).toEqual(
      Object.keys(english?.value.messages ?? {}).sort(),
    );
    await app.stop();
  });

  test('disposes its contribution with the extension', async () => {
    const app = await started();
    await app.stop();

    expect(app.contributions.has(memories, 'local')).toBe(false);
  });
});
