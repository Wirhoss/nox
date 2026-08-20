import { satisfies, valid, validRange } from 'semver';
import { z } from 'zod';

import { parseOrThrow } from '../utils/validate';
import { identifierSchema } from './identifier';

const semanticVersionRangeSchema = z
  .string()
  .refine((value) => validRange(value) !== null, 'Expected a valid semantic version range.');

/**
 * Identity and compatibility, and nothing else. `version`, `apiVersion` and the
 * dependency graph stay with the deferred machinery: they describe how an extension
 * is *distributed*, and nothing is distributed yet. A compatibility range is
 * different — it is what an extension asserts about the runtime it was written for,
 * and adding it later would break every manifest at once.
 */
const extensionManifestSchema = z.strictObject({
  engines: z.strictObject({ nox: semanticVersionRangeSchema }),
  id: identifierSchema,
});

type ExtensionManifest = z.infer<typeof extensionManifestSchema>;

function parseExtensionManifest(input: unknown): ExtensionManifest {
  const manifest = parseOrThrow(extensionManifestSchema, input);
  return Object.freeze({ ...manifest, engines: Object.freeze({ ...manifest.engines }) });
}

/**
 * A prerelease *inside* the range satisfies it: a runtime at `0.2.1-rc.1` still
 * runs an extension that asked for `^0.2.0`. Without this every release candidate
 * would read as incompatible with every extension. Note this does not reach
 * backwards — `0.2.0-rc.1` precedes `0.2.0` and does not satisfy `^0.2.0`,
 * which is correct: that extension was written for a release that has not shipped.
 */
function isCompatible(manifest: ExtensionManifest, noxVersion: string): boolean {
  return satisfies(noxVersion, manifest.engines.nox, { includePrerelease: true });
}

/** Guards the other side: a runtime version that is not a version makes every
 *  extension look incompatible for a reason nobody would find. */
function assertVersion(value: string, kind: string): void {
  if (valid(value) === null) {
    throw new TypeError(`Invalid ${kind} "${value}": expected a semantic version.`);
  }
}

export { assertVersion, extensionManifestSchema, isCompatible, parseExtensionManifest };

export type { ExtensionManifest };
