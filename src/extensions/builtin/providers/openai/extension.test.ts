import { describe, expect, test } from 'bun:test';

import { NoxApplication } from '../../../../application';
import { translationFragments } from '../../../contribution-points/languages';
import { providers } from '../../../contribution-points/providers';
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

  test('owns every locale for its own UI namespace', async () => {
    const app = await started();

    const english = app.contributions.get(translationFragments, 'nox.provider.openai.en');
    const spanish = app.contributions.get(translationFragments, 'nox.provider.openai.es');

    expect(english?.extensionId).toBe('nox.provider.openai');
    expect(english?.value.namespace).toBe('nox.provider.openai');
    expect(english?.value.messages['ui.baseUrl']).toBe('Base URL');
    expect(spanish?.extensionId).toBe('nox.provider.openai');
    expect(spanish?.value.namespace).toBe('nox.provider.openai');
    expect(spanish?.value.messages['ui.baseUrl']).toBe('URL base');
    expect(Object.keys(spanish?.value.messages ?? {}).sort()).toEqual(
      Object.keys(english?.value.messages ?? {}).sort(),
    );
    await app.stop();
  });

  test('declares the adapter schema rather than hiding it', async () => {
    const app = await started();

    // The configuration module can only validate `providers.json` by reading
    // this; a schema kept inside `create` would leave the file uncheckable.
    const contribution = app.contributions.get(providers, 'openai_completions');

    expect(contribution?.value.configSchema).toBe(OpenAICompletions.configSchema);
    expect(contribution?.value.configSchema.shape.type.value).toBe('openai_completions');
    await app.stop();
  });

  test('builds an adapter from a valid configuration', async () => {
    const app = await started();
    const config = OpenAICompletions.configSchema.parse({
      baseUrl: 'https://api.example.test/v1',
      defaultModel: 'gpt-test',
      type: 'openai_completions',
    });

    const provider = app.contributions
      .get(providers, 'openai_completions')
      // The stored shape carries a reference where the runtime one carries a
      // handle; this entry names no credential, so there is nothing to resolve.
      ?.value.create({ ...config, apiKey: undefined });

    expect(provider).toBeInstanceOf(OpenAICompletions);
    await app.stop();
  });

  test('its schema refuses a configuration that is not its own', async () => {
    const app = await started();
    const contribution = app.contributions.get(providers, 'openai_completions');

    // No `baseUrl`, and the discriminator names another provider entirely.
    const result = contribution?.value.configSchema.safeParse({ type: 'anthropic' });

    expect(result?.success).toBeFalse();
    await app.stop();
  });

  test('the contribution is gone once the extension is disposed', async () => {
    const app = await started();
    await app.stop();

    expect(app.contributions.has(providers, 'openai_completions')).toBe(false);
  });
});
