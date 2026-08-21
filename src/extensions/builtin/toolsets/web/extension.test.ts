import { describe, expect, test } from 'bun:test';

import { NoxApplication } from '../../../../application';
import { toolSets } from '../../../contribution-points/toolsets';
import { webToolsExtension } from './extension';
import { WebTools } from './webTools';

async function started(): Promise<NoxApplication> {
  const app = new NoxApplication({ extensions: [webToolsExtension] });
  await app.start();
  return app;
}

describe('webToolsExtension', () => {
  test('contributes its declared tool-set factory', async () => {
    const app = await started();
    const contribution = app.contributions.get(toolSets, 'web');

    expect(contribution?.extensionId).toBe('nox.toolset.web');
    expect(contribution?.value.configSchema).toBe(WebTools.configSchema);
    expect(contribution?.value.configSchema.shape.type.value).toBe('web');
    await app.stop();
  });

  test('builds a configured tool set and disposes its contribution', async () => {
    const app = await started();
    const contribution = app.contributions.get(toolSets, 'web');
    const config = WebTools.configSchema.parse({
      search: { url: 'https://search.example.test' },
      type: 'web',
    });

    expect(contribution?.value.create(config)).toBeInstanceOf(WebTools);
    await app.stop();
    expect(app.contributions.has(toolSets, 'web')).toBe(false);
  });
});
