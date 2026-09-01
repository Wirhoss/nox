import { readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CONTROL_PLANE_SERVICE_IDS,
  EXTENSION_API_VERSION,
  isExtensionDefinition,
} from '@nox/extension-api';

import { ExtensionCatalog } from './catalog';
import { confinedExtension } from './confined/confinedExtension';
import { unconfinableReason } from './confinement';
import { bindExtensionManifest } from './extension';
import { unsatisfiedHostPackages } from './hostPackages';
import {
  EXTENSION_MANIFEST_FILENAME,
  isCompatible,
  isExtensionApiCompatible,
  parseExtensionManifest,
} from './manifest';

import type { Logger } from '../logger/logger';
import type { ExtensionOrigin } from './catalog';
import type { NoxExtension } from './extension';
import type { ExtensionDefinition, ExtensionManifest } from '@nox/extension-api';

interface ExtensionDirectory {
  readonly directory: string;
  readonly origin: ExtensionOrigin;
}

interface DiscoverExtensionsOptions {
  readonly directories: readonly ExtensionDirectory[];
  readonly logger: Logger;
  readonly noxVersion: string;
  /**
   * Load installed extensions even where the kernel cannot confine them.
   *
   * The operator's deliberate choice, and the only way past the refusal below.
   * Never a fallback: an installation that quietly ran guests in Nox's own
   * process would look exactly like one that confined them.
   */
  readonly runUnconfined?: boolean;
}

interface DiscoveredExtensions {
  readonly catalog: ExtensionCatalog;
  readonly extensions: readonly NoxExtension[];
}

interface Candidate {
  readonly directory: string;
  readonly key: string;
  readonly manifestPath: string;
  readonly origin: ExtensionOrigin;
}

interface ParsedCandidate extends Candidate {
  readonly manifest: ExtensionManifest;
}

/**
 * Finds packages in every configured root, then subjects all origins to exactly
 * the same validation, compatibility, import, and activation path.
 */
async function discoverExtensions(
  options: DiscoverExtensionsOptions,
): Promise<DiscoveredExtensions> {
  const catalog = new ExtensionCatalog();
  const candidates = (
    await Promise.all(
      options.directories.map((source) => extensionCandidates(source, options.logger)),
    )
  )
    .flat()
    .sort((left, right) => left.key.localeCompare(right.key));

  const parsed: ParsedCandidate[] = [];
  for (const candidate of candidates) {
    try {
      const manifest = parseExtensionManifest(
        JSON.parse(await readFile(candidate.manifestPath, 'utf8')) as unknown,
      );
      catalog.add(candidate.key, {
        ...(manifest.hostPackages === undefined ? {} : { hostPackages: manifest.hostPackages }),
        id: manifest.id,
        origin: candidate.origin,
        ...(manifest.services === undefined ? {} : { services: manifest.services }),
        version: manifest.version,
      });
      parsed.push({ ...candidate, manifest });
    } catch (error) {
      catalog.add(candidate.key, {
        error: messageFrom(error),
        id: basename(candidate.directory),
        origin: candidate.origin,
        state: 'failed',
      });
      options.logger.error(
        { err: error, manifest: candidate.manifestPath, origin: candidate.origin },
        'Extension manifest is invalid.',
      );
    }
  }

  const duplicates = duplicateIds(parsed);
  const extensions: NoxExtension[] = [];
  for (const candidate of parsed) {
    const { key, manifest, origin } = candidate;
    if (duplicates.has(manifest.id)) {
      const error = `Extension ID "${manifest.id}" is present more than once.`;
      catalog.fail(key, error);
      options.logger.error({ extensionId: manifest.id, origin }, error);
      continue;
    }
    // The `nox.` namespace is the core's, and an ID is what claims it: an
    // installed package calling itself `nox.anything` registers authorities
    // under `nox.anything.*`, which an existing grant of `nox.*` already
    // covers. Nothing downstream can tell that apart from the core's own — the
    // name is the only evidence there is — so the name is refused here.
    if (origin !== 'builtin' && isReservedId(manifest.id)) {
      const error = `Extension ID "${manifest.id}" is reserved: only builtins may use the "nox." namespace.`;
      catalog.fail(key, error);
      options.logger.error({ extensionId: manifest.id, origin }, error);
      continue;
    }
    // Settled here rather than at the first `get`. The scoped container refuses
    // a control-plane service whenever it is asked, but "whenever" can be deep
    // inside a `create` that runs when somebody edits configuration hours
    // later. The manifest already says enough to answer now, and a package that
    // can never have what it declared should not be counted as loaded.
    //
    // The package is turned away; Nox is not. Discovery drops it, logs why, and
    // rolls the rest forward, which is what every other refusal here does.
    const restricted =
      origin === 'builtin'
        ? []
        : (manifest.services ?? []).filter((id) => CONTROL_PLANE_SERVICE_IDS.includes(id));
    if (restricted.length > 0) {
      const error =
        `Extension "${manifest.id}" declares ${restricted.join(', ')}, ` +
        'reserved to Nox builtins; an installed extension cannot be granted it.';
      catalog.fail(key, error);
      options.logger.error({ extensionId: manifest.id, origin }, error);
      continue;
    }
    // The refusal this whole design was built to be able to make, and the one
    // place it can be made honestly: before a guest's code has run at all.
    //
    // Refusing is the default because the alternative is indistinguishable from
    // success at every later point. The operator can choose it, and then it is
    // a choice somebody made rather than something that happened.
    const confine = origin !== 'builtin' && options.runUnconfined !== true;
    if (confine) {
      const unconfinable = unconfinableReason();
      if (unconfinable !== undefined) {
        const error =
          `${unconfinable} Set NOX_ALLOW_UNCONFINED_EXTENSIONS=1 to load installed ` +
          'extensions into the Nox process anyway, which grants them everything it can reach.';
        catalog.fail(key, error);
        options.logger.error({ extensionId: manifest.id, origin }, error);
        continue;
      }
    } else if (origin !== 'builtin') {
      // Every start, not once. An installation running guests in its own
      // process should never be able to forget that it is.
      options.logger.warn(
        { extensionId: manifest.id, origin },
        'Loading an installed extension into the Nox process, unconfined, because this ' +
          'installation was configured to. It can reach everything Nox can reach.',
      );
    }
    if (!isCompatible(manifest, options.noxVersion)) {
      catalog.incompatible(
        key,
        `Requires Nox ${manifest.engines.nox}; this runtime is ${options.noxVersion}.`,
      );
      continue;
    }
    if (!isExtensionApiCompatible(manifest)) {
      catalog.incompatible(
        key,
        `Requires Extension API ${manifest.engines.extensionApi}; this runtime provides ${EXTENSION_API_VERSION}.`,
      );
      continue;
    }
    // Beside the engine checks rather than after activation: a library the host
    // cannot supply is the same kind of fact as a runtime version it does not
    // match, and both are cheaper to state now than to discover from a module
    // resolution error during somebody's conversation.
    const missingPackages = unsatisfiedHostPackages(manifest.hostPackages);
    if (missingPackages !== undefined) {
      catalog.incompatible(key, `${missingPackages}.`);
      continue;
    }

    try {
      const entryPoint = await packagePath(candidate, manifest.main, 'entry point');
      const migrations =
        manifest.migrations === undefined
          ? undefined
          : await packagePath(candidate, manifest.migrations, 'migrations directory');
      // Where the two origins finally part. A builtin ships inside the image
      // and is part of Nox, so it is imported here and runs in this process. An
      // installed package is a guest: it is never imported here at all — the
      // path is handed to a process that confines itself first and imports
      // afterwards, which is the whole of the isolation the README promised.
      //
      // The one exception is the operator's opt-out, and it is a full one: it
      // means the old behaviour, in this process, with everything that used to
      // work still working. An unconfined *child* would have been a third thing
      // — no kernel restriction, and none of the crossings either — which is
      // strictly worse than both.
      const definition = confine
        ? confinedExtension({ entryPoint, logger: options.logger, manifest })
        : await importDefinition(entryPoint);
      extensions.push(
        bindExtensionManifest(
          manifest,
          definition,
          {
            activated: () => {
              catalog.active(key);
            },
            activationFailed: (error) => {
              catalog.fail(key, error);
              options.logger.error(
                { err: error, extensionId: manifest.id, origin },
                'Extension activation failed.',
              );
            },
          },
          migrations,
          origin,
        ),
      );
    } catch (error) {
      catalog.fail(key, error);
      options.logger.error(
        { err: error, extensionId: manifest.id, origin },
        'Extension could not be loaded.',
      );
    }
  }

  return Object.freeze({ catalog, extensions: Object.freeze(extensions) });
}

/** A builtin's definition, imported into this process because it is part of it. */
async function importDefinition(entryPoint: string): Promise<ExtensionDefinition> {
  const loaded: unknown = await import(pathToFileURL(entryPoint).href);
  const definition =
    typeof loaded === 'object' && loaded !== null
      ? (loaded as { readonly default?: unknown }).default
      : undefined;
  if (!isExtensionDefinition(definition)) {
    throw new TypeError('The entry module must default-export an extension definition.');
  }
  return definition;
}

async function extensionCandidates(
  source: ExtensionDirectory,
  logger: Logger,
): Promise<readonly Candidate[]> {
  const root = resolve(source.directory);
  const manifests: string[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === root && isMissing(error)) {
        logger.warn(
          { directory: root, origin: source.origin },
          'Extension directory does not exist; treating it as empty.',
        );
        return;
      }
      throw error;
    }

    if (entries.some((entry) => entry.isFile() && entry.name === EXTENSION_MANIFEST_FILENAME)) {
      manifests.push(resolve(directory, EXTENSION_MANIFEST_FILENAME));
      return;
    }

    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'),
        )
        .map((entry) => walk(resolve(directory, entry.name))),
    );
  }

  try {
    await walk(root);
  } catch (error) {
    logger.error(
      { directory: root, err: error, origin: source.origin },
      'Extension directory could not be scanned.',
    );
    return [];
  }

  return manifests.map((manifestPath) => {
    const directory = dirname(manifestPath);
    const name = relative(root, directory).replaceAll(sep, '/');
    return {
      directory,
      key: `${source.origin}:${name}`,
      manifestPath,
      origin: source.origin,
    };
  });
}

/**
 * Resolves one manifest path against the package, following symlinks.
 *
 * The schema already refuses an absolute path or one containing `..`; this is
 * the half it cannot check, because a link only points outside once the disk is
 * consulted.
 */
async function packagePath(
  candidate: ParsedCandidate,
  declared: string,
  kind: string,
): Promise<string> {
  const packageDirectory = await realpath(candidate.directory);
  const resolved = await realpath(resolve(packageDirectory, declared));
  const within = relative(packageDirectory, resolved);
  if (within === '..' || within.startsWith(`..${sep}`) || within.length === 0) {
    throw new Error(`The extension ${kind} must be inside its package directory.`);
  }
  return resolved;
}

/** The core's own namespace, and the bare name of it. */
function isReservedId(id: string): boolean {
  return id === 'nox' || id.startsWith('nox.');
}

function duplicateIds(candidates: readonly ParsedCandidate[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const { manifest } of candidates)
    counts.set(manifest.id, (counts.get(manifest.id) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { discoverExtensions };

export type { DiscoveredExtensions, DiscoverExtensionsOptions, ExtensionDirectory };
