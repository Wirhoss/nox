import { defineExtension, isExtensionDefinition } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import { bindExtensionManifest } from './extension';

describe('defineExtension', () => {
  test('freezes package code without duplicating distribution identity', () => {
    const extension = defineExtension({
      activate() {
        // Nothing to contribute; module shape is what is under test.
      },
    });

    expect(Object.isFrozen(extension)).toBe(true);
    expect('manifest' in extension).toBeFalse();
    expect(isExtensionDefinition(extension)).toBeTrue();
  });

  test('rejects a module without activation', () => {
    expect(() => defineExtension({ activate: 7 } as never)).toThrow(TypeError);
    expect(isExtensionDefinition({})).toBeFalse();
  });
});

describe('bindExtensionManifest', () => {
  test('attaches validated package identity outside extension code', () => {
    const extension = bindExtensionManifest(
      {
        engines: { extensionApi: '^0.1.0', nox: '^0.1.0' },
        id: 'nox.example',
        main: 'extension.js',
        schemaVersion: 1,
        version: '1.2.3',
      },
      defineExtension({
        activate() {
          return;
        },
      }),
    );

    expect(Object.isFrozen(extension.manifest)).toBeTrue();
    expect(extension.manifest.id).toBe('nox.example');
    expect(extension.manifest.engines.nox).toBe('^0.1.0');
  });
});
