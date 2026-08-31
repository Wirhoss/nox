import { isAbsolute } from 'node:path';

import {
  EXTENSION_API_VERSION,
  HOST_PROVIDED_PACKAGES,
  identifierSchema,
} from '@nox/extension-api';
import { satisfies, valid, validRange } from 'semver';
import { z } from 'zod';

import { parseOrThrow } from '../utils/validate';

import type { ExtensionManifest } from '@nox/extension-api';

const EXTENSION_MANIFEST_FILENAME = 'nox-extension.json';

const semanticVersionSchema = z
  .string()
  .refine((value) => valid(value) !== null, 'Expected a valid semantic version.');

const semanticVersionRangeSchema = z
  .string()
  .refine((value) => validRange(value) !== null, 'Expected a valid semantic version range.');

/** Any path a manifest gives: relative to the package, and unable to leave it. */
const packagePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !isAbsolute(value), 'A manifest path must be relative.')
  .refine(
    (value) => !value.replaceAll('\\', '/').split('/').includes('..'),
    'A manifest path cannot leave its package directory.',
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
  /**
   * Packages taken from the host rather than bundled, name to semver range.
   *
   * The key set is closed on purpose. A name the host does not provide is not a
   * dependency Nox can be asked for; it is one the package has to carry, and
   * saying so in the manifest error is the only place an author will read it.
   */
  hostPackages: z
    .record(z.string(), semanticVersionRangeSchema)
    // Checked here rather than by a key schema, because a record reports an
    // invalid key as "invalid key" and drops the reason — and the reason is the
    // entire message: this is where an author learns the rule.
    .superRefine((packages, ctx) => {
      for (const name of Object.keys(packages)) {
        if (HOST_PROVIDED_PACKAGES.includes(name)) continue;
        ctx.addIssue({
          code: 'custom',
          message: `Nox provides only ${HOST_PROVIDED_PACKAGES.join(', ')}; bundle anything else into the package.`,
          path: [name],
        });
      }
    })
    .optional(),
  id: identifierSchema,
  main: packagePathSchema,
  /**
   * Directory of `.sql` files applied under this extension's migration history
   * in the shared extension database before it activates.
   *
   * Declared rather than created at runtime, for the same reason the kernel's
   * own schema is: an installation upgraded three times has to arrive at the
   * schema a fresh one starts with, and only a recorded, ordered set of
   * statements makes that true.
   */
  migrations: packagePathSchema.optional(),
  schemaVersion: z.literal(1),
  /**
   * Host services this package may resolve, by service ID.
   *
   * The whole of what an extension can reach into the host, written where an
   * operator can read it before installing rather than discovered by watching
   * the process. The loader hands over a container scoped to exactly this list;
   * absent is an empty list, not an unrestricted one.
   */
  services: z.array(identifierSchema).optional(),
  version: semanticVersionSchema,
  /**
   * Entry points this package loads at runtime rather than imports.
   *
   * A worker is started from a URL, which no bundler can follow: it would be
   * left out of a built package and the extension would fail at its first use
   * rather than at build time. Declaring them is what lets a build emit them
   * beside the entry point they are resolved against.
   */
  workers: z.array(packagePathSchema).optional(),
});

function parseExtensionManifest(input: unknown): ExtensionManifest {
  const manifest = parseOrThrow(extensionManifestSchema, input);
  return Object.freeze({
    ...manifest,
    engines: Object.freeze({ ...manifest.engines }),
    ...(manifest.hostPackages === undefined
      ? {}
      : { hostPackages: Object.freeze({ ...manifest.hostPackages }) }),
    ...(manifest.services === undefined ? {} : { services: Object.freeze([...manifest.services]) }),
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
