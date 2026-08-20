import { describe, expect, test } from 'bun:test';

import { defineExtension } from './extension';

describe('defineExtension', () => {
  test('freezes the extension and its manifest', () => {
    const extension = defineExtension({
      manifest: { engines: { nox: '^0.1.0' }, id: 'nox.example' },
      activate() {
        // Nothing to contribute; identity is what is under test.
      },
    });

    expect(Object.isFrozen(extension)).toBe(true);
    expect(Object.isFrozen(extension.manifest)).toBe(true);
    expect(Object.isFrozen(extension.manifest.engines)).toBe(true);
    expect(extension.manifest.id).toBe('nox.example');
    expect(extension.manifest.engines.nox).toBe('^0.1.0');
  });

  test('rejects an identifier that is not package-like at the declaration site', () => {
    expect(() =>
      defineExtension({
        manifest: { engines: { nox: '^0.1.0' }, id: 'Nox Example' },
        activate() {
          // Never reached.
        },
      }),
    ).toThrow(RangeError);
  });

  test('rejects a compatibility range that semver cannot parse', () => {
    expect(() =>
      defineExtension({
        manifest: { engines: { nox: 'newest' }, id: 'nox.example' },
        activate() {
          // Never reached.
        },
      }),
    ).toThrow(RangeError);
  });
});
