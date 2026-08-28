import {
  authorities,
  contributionInstances,
  toolSets,
  translationFragments,
} from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import { NoxApplication } from '../../../../application';
import { bindExtensionManifest } from '../../../extension';
import { webToolsExtension } from './extension';
import { WebToolSet } from './webToolSet';

async function started(): Promise<NoxApplication> {
  const app = new NoxApplication({
    extensions: [
      bindExtensionManifest(
        {
          engines: { extensionApi: '*', nox: '*' },
          id: 'nox.toolset.web',
          main: 'extension.js',
          schemaVersion: 1,
          version: '0.1.0',
        },
        webToolsExtension,
      ),
    ],
  });
  await app.start();
  return app;
}

describe('webToolsExtension', () => {
  test('contributes its declared tool-set factory', async () => {
    const app = await started();
    const contribution = app.contributions.get(toolSets, 'web');

    expect(contribution?.extensionId).toBe('nox.toolset.web');
    expect(contribution?.value.configSchema).toBe(WebToolSet.configSchema);
    expect(contribution?.value.configSchema.shape.type.value).toBe('web');
    expect(contribution === undefined ? undefined : contributionInstances(contribution.value)).toBe(
      'single',
    );
    await app.stop();
  });

  test('owns every locale for its own UI namespace', async () => {
    const app = await started();

    const english = app.contributions.get(translationFragments, 'nox.toolset.web.en');
    const spanish = app.contributions.get(translationFragments, 'nox.toolset.web.es');

    expect(english?.extensionId).toBe('nox.toolset.web');
    expect(english?.value.namespace).toBe('nox.toolset.web');
    expect(english?.value.messages['ui.serviceUrl']).toBe('Service URL');
    expect(spanish?.extensionId).toBe('nox.toolset.web');
    expect(spanish?.value.namespace).toBe('nox.toolset.web');
    expect(spanish?.value.messages['ui.serviceUrl']).toBe('URL del servicio');
    expect(Object.keys(spanish?.value.messages ?? {}).sort()).toEqual(
      Object.keys(english?.value.messages ?? {}).sort(),
    );
    await app.stop();
  });

  test('registers arbitrary browser evaluation as its own authority', async () => {
    const app = await started();

    const contribution = app.contributions.get(authorities, 'nox.toolset.web.browser.evaluate');
    expect(contribution?.extensionId).toBe('nox.toolset.web');
    expect(contribution?.value.description).toContain('arbitrary JavaScript');
    await app.stop();
  });

  test('builds a configured tool set and disposes its contribution', async () => {
    const app = await started();
    const contribution = app.contributions.get(toolSets, 'web');
    const config = WebToolSet.configSchema.parse({
      search: { module: 'searxng', url: 'https://search.example.test' },
      type: 'web',
    });

    expect(contribution?.value.create(config)).toBeInstanceOf(WebToolSet);
    await app.stop();
    expect(app.contributions.has(toolSets, 'web')).toBe(false);
  });
});
