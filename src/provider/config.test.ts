import { describe, expect, test } from 'bun:test';

import {
  modelAcceptsInput,
  modelConfigSchema,
  modelInputModalities,
  modelProducesOutput,
} from './config';

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

  test('materializes output capabilities beside the legacy text type', () => {
    expect(modelConfigSchema.parse({ modelId: 'legacy', type: 'text' })).toEqual({
      inputModalities: ['text'],
      modelId: 'legacy',
      outputModalities: ['text'],
      type: 'text',
    });
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
