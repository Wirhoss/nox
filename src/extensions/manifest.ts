import { isAbsolute } from 'node:path';

import {
  EXTENSION_API_VERSION,
  type ExtensionManifest,
  identifierSchema,
} from '@nox/extension-api';
import { satisfies, valid, validRange } from 'semver';
import { z } from 'zod';

import { parseOrThrow } from '../utils/validate';

const EXTENSION_MANIFEST_FILENAME = 'nox-extension.json';

const semanticVersionSchema = z
  .string()
  .refine((value) => valid(value) !== null, 'Expected a valid semantic version.');

const semanticVersionRangeSchema = z
  .string()
  .refine((value) => validRange(value) !== null, 'Expected a valid semantic version range.');

const extensionMainSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !isAbsolute(value), 'The extension entry point must be relative.')
  .refine(
    (value) => !value.replaceAll('\\', '/').split('/').includes('..'),
    'The extension entry point cannot leave its package directory.',
  );

/**
 * Distribution identity and compatibility. Both compatibility declarations are
 * semver ranges: an extension may support a family of Nox/API releases. Its own
 * `version` is exact because it identifies the installed artifact.
 */
const extensionManifestSchema = z.strictObject({
  engines: z.strictObject({
    extensionApi: semanticVersionRangeSchema,
    nox: semanticVersionRangeSchema,
  }),
  id: identifierSchema,
  main: extensionMainSchema,
  schemaVersion: z.literal(1),
  version: semanticVersionSchema,
  /**
   * Entry points this package loads at runtime rather than imports.
   *
   * A worker is started from a URL, which no bundler can follow: it would be
   * left out of a built package and the extension would fail at its first use
   * rather than at build time. Declaring them is what lets a build emit them
   * beside the entry point they are resolved against.
   */
  workers: z.array(extensionMainSchema).optional(),
});

function parseExtensionManifest(input: unknown): ExtensionManifest {
  const manifest = parseOrThrow(extensionManifestSchema, input);
  return Object.freeze({
    ...manifest,
    engines: Object.freeze({ ...manifest.engines }),
    ...(manifest.workers === undefined ? {} : { workers: Object.freeze([...manifest.workers]) }),
  });
}

function satisfiesRange(version: string, range: string): boolean {
  return satisfies(version, range, { includePrerelease: true });
}

function isCompatible(manifest: ExtensionManifest, noxVersion: string): boolean {
  return satisfiesRange(noxVersion, manifest.engines.nox);
}

function isExtensionApiCompatible(manifest: ExtensionManifest): boolean {
  return satisfiesRange(EXTENSION_API_VERSION, manifest.engines.extensionApi);
}

/** Guards the other side: an invalid runtime/API version makes every extension misleadingly fail. */
function assertVersion(value: string, kind: string): void {
  if (valid(value) === null) {
    throw new TypeError(`Invalid ${kind} "${value}": expected a semantic version.`);
  }
}

export {
  assertVersion,
  EXTENSION_MANIFEST_FILENAME,
  extensionManifestSchema,
  isCompatible,
  isExtensionApiCompatible,
  parseExtensionManifest,
  semanticVersionRangeSchema,
  semanticVersionSchema,
};
