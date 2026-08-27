import {
  modelAcceptsInput,
  modelConfigSchema,
  modelInputModalities,
  modelProducesOutput,
  providerRuntimeConfigSchema,
} from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

describe('provider runtime configuration', () => {
  test('accepts a host secret capability without relying on constructor identity', () => {
    // This deliberately is not Config.SecretHandle. A compiled extension has a
    // separate module graph and must accept the genuine host handle structurally.
    class ForeignSecretHandle {
      public readonly id = 'DEEPSEEK_API_KEY';

      public reveal(): string {
        return 'not-exposed';
      }
    }

    const handle = new ForeignSecretHandle();
    const parsed = providerRuntimeConfigSchema.parse({
      apiKey: handle,
      baseUrl: 'https://api.deepseek.com/v1',
    });

    expect(parsed.apiKey?.reveal()).toBe('not-exposed');
  });
});

describe('model modalities', () => {
  test('is text-only until additional capabilities are declared', () => {
    const model = modelConfigSchema.parse({ modelId: 'plain' });

    expect(modelInputModalities(model)).toEqual(['text']);
    expect(model.outputModalities).toEqual(['text']);
    expect(modelAcceptsInput(model, 'text')).toBe(true);
    expect(modelAcceptsInput(model, 'image')).toBe(false);
    expect(modelProducesOutput(model, 'text')).toBe(true);
  });

  test('keeps input and output modalities as independent capabilities', () => {
    const model = modelConfigSchema.parse({
      inputModalities: ['text', 'image', 'audio'],
      modelId: 'multimodal',
      outputModalities: ['text', 'audio'],
    });

    expect(modelAcceptsInput(model, 'image')).toBe(true);
    expect(modelAcceptsInput(model, 'audio')).toBe(true);
    expect(modelProducesOutput(model, 'image')).toBe(false);
    expect(modelProducesOutput(model, 'audio')).toBe(true);
  });

  test('refuses a chat model without text on either side of its contract', () => {
    expect(
      modelConfigSchema.safeParse({ inputModalities: ['image'], modelId: 'broken-input' }).success,
    ).toBe(false);
    expect(
      modelConfigSchema.safeParse({ modelId: 'broken-output', outputModalities: ['audio'] })
        .success,
    ).toBe(false);
  });
});
