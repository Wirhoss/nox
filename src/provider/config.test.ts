import {
  chatModelConfigSchema,
  ChatProvider,
  httpProviderRuntimeConfigSchema,
  isChatCapable,
  isEmbeddingCapable,
  modelAcceptsInput,
  modelInputModalities,
  modelProducesOutput,
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
    const parsed = httpProviderRuntimeConfigSchema.parse({
      apiKey: handle,
      baseUrl: 'https://api.deepseek.com/v1',
    });

    expect(parsed.apiKey?.reveal()).toBe('not-exposed');
  });
});

describe('provider capability detection', () => {
  const foreignProvider = (kind: 'chat' | 'embedding') => ({
    addModelConfig: (): void => undefined,
    chatModelConfig: (): undefined => undefined,
    embeddingModelConfig: (): undefined => undefined,
    fetchModelIds: (): Promise<string[]> => Promise.resolve([]),
    getModelConfig: (): undefined => undefined,
    listModelConfigs: (): never[] => [],
    supports: (requested: 'chat' | 'embedding'): boolean => requested === kind,
  });

  test('accepts a chat provider from another extension API module graph', () => {
    const provider = {
      ...foreignProvider('chat'),
      getMessageStream: (): undefined => undefined,
    };

    expect(provider).not.toBeInstanceOf(ChatProvider);
    expect(isChatCapable(provider)).toBe(true);
    expect(isEmbeddingCapable(provider)).toBe(false);
  });

  test('accepts an embedding provider structurally and still requires its operation', () => {
    const provider = foreignProvider('embedding');

    expect(isEmbeddingCapable(provider)).toBe(false);
    expect(isEmbeddingCapable({ ...provider, embed: (): undefined => undefined })).toBe(true);
    expect(isChatCapable(provider)).toBe(false);
  });
});

describe('model modalities', () => {
  test('refuses agent generation policy in provider model declarations', () => {
    expect(
      chatModelConfigSchema.safeParse({
        maxTokens: 512,
        modelId: 'plain',
        stop: ['END'],
        temperature: 0.2,
      }).success,
    ).toBe(false);
  });

  test('is text-only until additional capabilities are declared', () => {
    const model = chatModelConfigSchema.parse({ modelId: 'plain' });

    expect(modelInputModalities(model)).toEqual(['text']);
    expect(model.outputModalities).toEqual(['text']);
    expect(modelAcceptsInput(model, 'text')).toBe(true);
    expect(modelAcceptsInput(model, 'image')).toBe(false);
    expect(modelProducesOutput(model, 'text')).toBe(true);
  });

  test('keeps input and output modalities as independent capabilities', () => {
    const model = chatModelConfigSchema.parse({
      kind: 'chat',
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
      chatModelConfigSchema.safeParse({ inputModalities: ['image'], modelId: 'broken-input' })
        .success,
    ).toBe(false);
    expect(
      chatModelConfigSchema.safeParse({ modelId: 'broken-output', outputModalities: ['audio'] })
        .success,
    ).toBe(false);
  });
});
