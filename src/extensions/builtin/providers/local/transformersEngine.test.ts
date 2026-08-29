import { describe, expect, test } from 'bun:test';

import { createTransformersEngine } from './transformersEngine';

describe('the Transformers engine', () => {
  test("uses the configured filesystem cache instead of Bun's browser cache", () => {
    const env = {
      cacheDir: '/read-only/package/cache',
      useBrowserCache: true,
      useFSCache: false,
    };

    createTransformersEngine(
      {
        env,
        pipeline: () => Promise.reject(new Error('The pipeline is lazy in this test.')),
      },
      { cacheDirectory: '/var/lib/nox/models', modelId: 'test/model' },
    );

    expect(env).toEqual({
      cacheDir: '/var/lib/nox/models',
      useBrowserCache: false,
      useFSCache: true,
    });
  });
});
