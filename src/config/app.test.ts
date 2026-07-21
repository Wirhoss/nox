import { describe, expect, test } from 'bun:test';

import { appConfigSchema } from './app';

const baseConfig = {
  logLevel: 'info' as const,
  server: { host: '127.0.0.1', port: 3001 },
};

describe('appConfigSchema runner retries', () => {
  test('defaults to three attempts', () => {
    expect(appConfigSchema.parse(baseConfig).runner).toEqual({
      maxAttempts: 3,
      retryDelayMs: 1_000,
    });
  });

  test('accepts a custom retry policy', () => {
    expect(appConfigSchema.parse({
      ...baseConfig,
      runner: { maxAttempts: 5, retryDelayMs: 2_500 },
    }).runner).toEqual({
      maxAttempts: 5,
      retryDelayMs: 2_500,
    });
  });
});
