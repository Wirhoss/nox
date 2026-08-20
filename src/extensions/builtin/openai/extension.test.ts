import { describe, expect, test } from 'bun:test';

import { NoxApplication } from '../../../application';
import { providers } from '../../contribution-points/providers';
import { openAIExtension } from './extension';
import { OpenAICompletions } from './openAICompletions';

async function started(): Promise<NoxApplication> {
  const app = new NoxApplication({ extensions: [openAIExtension] });
  await app.start();
  return app;
}

describe('openAIExtension', () => {
  test('contributes a provider factory attributed to itself', async () => {
    const app = await started();

    const contribution = app.contributions.get(providers, 'openai_completions');

    expect(contribution?.extensionId).toBe('nox.provider.openai');
    await app.stop();
  });

  test('builds an adapter from a valid configuration', async () => {
    const app = await started();

    const provider = app.contributions.get(providers, 'openai_completions')?.value.create({
      baseUrl: 'https://api.example.test/v1',
      defaultModel: 'gpt-test',
      type: 'openai_completions',
    });

    expect(provider).toBeInstanceOf(OpenAICompletions);
    await app.stop();
  });

  test('refuses a configuration that is not its own', () => {
    const app = new NoxApplication({ extensions: [openAIExtension] });

    return app.start().then(() => {
      const contribution = app.contributions.get(providers, 'openai_completions');

      // No `baseUrl`, and the discriminator names another provider entirely.
      expect(() => contribution?.value.create({ type: 'anthropic' })).toThrow(RangeError);
      return app.stop();
    });
  });

  test('the contribution is gone once the extension is disposed', async () => {
    const app = await started();
    await app.stop();

    expect(app.contributions.has(providers, 'openai_completions')).toBe(false);
  });
});
