import { describe, expect, test } from 'bun:test';

import { NOX_VERSION } from './version';

describe('NOX_VERSION', () => {
  test('matches the version in package.json', async () => {
    const manifest = (await Bun.file(
      new URL('../package.json', import.meta.url),
    ).json()) as unknown;
    const version =
      typeof manifest === 'object' && manifest !== null && 'version' in manifest
        ? manifest.version
        : undefined;

    expect(version).toBe(NOX_VERSION);
  });
});
