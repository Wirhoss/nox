import { describe, expect, test } from 'bun:test';

import {
  type ArtifactProcessor,
  ArtifactProcessorRegistry,
  type ArtifactProcessorSource,
} from './processor';

import type { RepresentationProfile } from './representation';

const SOURCE: ArtifactProcessorSource = Object.freeze({
  blobHash: 'a'.repeat(64),
  mediaType: 'image/png',
  size: 12,
});

const PROFILE: RepresentationProfile = Object.freeze({
  id: 'test.image',
  mediaTypes: Object.freeze(['image/webp']),
  transform: Object.freeze({ width: 512 }),
  version: 1,
});

function processor(id: string, priority = 0, supports = true): ArtifactProcessor {
  return {
    id,
    priority,
    process: () => ({ data: new Blob(), mediaType: 'image/webp' }),
    supports: () => supports,
    version: '1',
  };
}

describe('ArtifactProcessorRegistry', () => {
  test('selects by priority and then stable ID rather than registration order', () => {
    const registry = new ArtifactProcessorRegistry([
      processor('test.z', 10),
      processor('test.unsupported', 100, false),
      processor('test.b', 20),
      processor('test.a', 20),
    ]);

    expect(registry.select(SOURCE, PROFILE)?.id).toBe('test.a');
  });

  test('rejects ambiguous and non-canonical registrations', () => {
    const registry = new ArtifactProcessorRegistry([processor('test.one')]);

    expect(() => registry.register(processor('test.one', 1))).toThrow('already registered');
    expect(() => registry.register(processor(' Test.Two '))).toThrow('canonical form');
    expect(() => registry.register(processor('test.two', 0.5))).toThrow('safe integer');
  });

  test('registration disposal is idempotent and removes only that processor', () => {
    const registry = new ArtifactProcessorRegistry();
    const unregister = registry.register(processor('test.one'));

    expect(registry.select(SOURCE, PROFILE)?.id).toBe('test.one');
    unregister.dispose();
    unregister.dispose();
    expect(registry.select(SOURCE, PROFILE)).toBeUndefined();
  });
});
