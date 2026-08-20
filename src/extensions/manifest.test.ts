import { describe, expect, test } from 'bun:test';

import { assertVersion, isCompatible, parseExtensionManifest } from './manifest';

describe('parseExtensionManifest', () => {
  test('rejects a field the manifest does not define yet', () => {
    expect(() =>
      parseExtensionManifest({
        engines: { nox: '^0.1.0' },
        id: 'nox.example',
        version: '1.0.0',
      }),
    ).toThrow(RangeError);
  });

  test('names the offending field in the message', () => {
    expect(() => parseExtensionManifest({ engines: { nox: 'newest' }, id: 'nox.example' })).toThrow(
      /engines\.nox/,
    );
  });
});

describe('isCompatible', () => {
  const cases: [range: string, version: string, compatible: boolean][] = [
    ['^0.1.0', '0.1.4', true],
    ['^0.1.0', '0.2.0', false],
    ['^0.1.0', '0.1.4-rc.1', true],
    ['~0.1.2', '0.1.9', true],
    ['~0.1.2', '0.2.0', false],
    ['0.1.0', '0.1.0', true],
    ['0.1.0', '0.1.1', false],
    ['*', '9.9.9', true],
  ];

  for (const [range, version, compatible] of cases) {
    test(`${version} ${compatible ? 'satisfies' : 'does not satisfy'} ${range}`, () => {
      const manifest = parseExtensionManifest({ engines: { nox: range }, id: 'nox.example' });

      expect(isCompatible(manifest, version)).toBe(compatible);
    });
  }
});

describe('assertVersion', () => {
  test('accepts a semantic version and rejects a range', () => {
    expect(() => {
      assertVersion('0.1.0', 'Nox version');
    }).not.toThrow();
    expect(() => {
      assertVersion('^0.1.0', 'Nox version');
    }).toThrow(TypeError);
  });
});
