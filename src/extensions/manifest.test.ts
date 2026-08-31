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

  test('accepts and freezes separately built worker entry points', () => {
    const parsed = parseExtensionManifest({ ...manifest(), workers: ['worker.js'] });

    expect(parsed.workers).toEqual(['worker.js']);
    expect(Object.isFrozen(parsed.workers)).toBeTrue();
  });

  test('accepts and freezes the services a package declares', () => {
    const parsed = parseExtensionManifest({ ...manifest(), services: ['nox.artifact-pipeline'] });

    expect(parsed.services).toEqual(['nox.artifact-pipeline']);
    expect(Object.isFrozen(parsed.services)).toBeTrue();
  });

  // Absent is an empty grant, not an unrestricted one, and the parser keeps the
  // difference rather than filling in a default the loader would have to guess.
  test('leaves an undeclared service list absent', () => {
    expect(parseExtensionManifest(manifest()).services).toBeUndefined();
  });

  test('rejects a service ID that is not a service ID', () => {
    expect(() => parseExtensionManifest({ ...manifest(), services: ['Nox Clock'] })).toThrow(
      /services/u,
    );
  });

  test('accepts host packages the host actually provides', () => {
    const parsed = parseExtensionManifest({ ...manifest(), hostPackages: { zod: '^4.0.0' } });

    expect(parsed.hostPackages).toEqual({ zod: '^4.0.0' });
    expect(Object.isFrozen(parsed.hostPackages)).toBeTrue();
  });

  // The closed key set is the rule "if Nox does not provide it, bundle it"
  // written where a build will hit it, rather than in prose nobody reads twice.
  test('rejects a package the host does not provide, and says to bundle it', () => {
    expect(() =>
      parseExtensionManifest({ ...manifest(), hostPackages: { 'left-pad': '^1.0.0' } }),
    ).toThrow(/bundle anything else into the package/u);
  });

  test('rejects an exact version where a range belongs', () => {
    expect(() =>
      parseExtensionManifest({ ...manifest(), hostPackages: { zod: 'latest' } }),
    ).toThrow(/hostPackages/u);
  });

  test('rejects fields it does not define and entry points outside the package', () => {
    expect(() => parseExtensionManifest({ ...manifest(), surprise: true })).toThrow(RangeError);
    expect(() => parseExtensionManifest({ ...manifest(), main: '../outside.js' })).toThrow(/main/u);
    expect(() => parseExtensionManifest({ ...manifest(), workers: ['../outside.js'] })).toThrow(
      /workers/u,
    );
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
