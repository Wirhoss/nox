import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXTENSION_API_VERSION } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import {
  assertVersion,
  isCompatible,
  isExtensionApiCompatible,
  parseExtensionManifest,
} from './manifest';

function manifest(nox = '^0.1.0', extensionApi = '^0.1.0'): Record<string, unknown> {
  return {
    engines: { extensionApi, nox },
    id: 'nox.example',
    main: 'extension.js',
    schemaVersion: 1,
    version: '1.0.0',
  };
}

test('the public package and runtime advertise one Extension API version', () => {
  const packageJson = JSON.parse(
    readFileSync(
      join(import.meta.dir, '..', '..', 'packages', 'extension-api', 'package.json'),
      'utf8',
    ),
  ) as { version?: string };
  expect(packageJson.version).toBe(EXTENSION_API_VERSION);
});

describe('parseExtensionManifest', () => {
  test('accepts ranges for compatibility and an exact package version', () => {
    expect(parseExtensionManifest(manifest()).engines).toEqual({
      extensionApi: '^0.1.0',
      nox: '^0.1.0',
    });
    expect(() => parseExtensionManifest({ ...manifest(), version: '^1.0.0' })).toThrow(/version/u);
  });

  test('rejects fields it does not define and entry points outside the package', () => {
    expect(() => parseExtensionManifest({ ...manifest(), surprise: true })).toThrow(RangeError);
    expect(() => parseExtensionManifest({ ...manifest(), main: '../outside.js' })).toThrow(/main/u);
  });

  test('names an offending compatibility range', () => {
    expect(() => parseExtensionManifest(manifest('newest'))).toThrow(/engines\.nox/u);
    expect(() => parseExtensionManifest(manifest('*', 'newest'))).toThrow(/engines\.extensionApi/u);
  });
});

describe('extension compatibility', () => {
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
      expect(isCompatible(parseExtensionManifest(manifest(range)), version)).toBe(compatible);
    });
  }

  test('checks the Extension API against its own range', () => {
    expect(isExtensionApiCompatible(parseExtensionManifest(manifest('*', '^0.1.0')))).toBeTrue();
    expect(isExtensionApiCompatible(parseExtensionManifest(manifest('*', '^2.0.0')))).toBeFalse();
  });
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
