import { readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EXTENSION_API_VERSION,
  type ExtensionManifest,
  isExtensionDefinition,
} from '@nox/extension-api';

import { ExtensionCatalog, type ExtensionOrigin } from './catalog';
import { bindExtensionManifest, type NoxExtension } from './extension';
import {
  EXTENSION_MANIFEST_FILENAME,
  isCompatible,
  isExtensionApiCompatible,
  parseExtensionManifest,
} from './manifest';

import type { Logger } from '../logger/logger';

interface ExtensionDirectory {
  readonly directory: string;
  readonly origin: ExtensionOrigin;
}

interface DiscoverExtensionsOptions {
  readonly directories: readonly ExtensionDirectory[];
  readonly logger: Logger;
  readonly noxVersion: string;
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
        id: manifest.id,
        origin: candidate.origin,
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

    try {
      const entryPoint = await packageEntryPoint(candidate);
      const loaded: unknown = await import(pathToFileURL(entryPoint).href);
      const definition =
        typeof loaded === 'object' && loaded !== null
          ? (loaded as { readonly default?: unknown }).default
          : undefined;
      if (!isExtensionDefinition(definition)) {
        throw new TypeError('The entry module must default-export an extension definition.');
      }
      extensions.push(
        bindExtensionManifest(manifest, definition, {
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
        }),
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

async function packageEntryPoint(candidate: ParsedCandidate): Promise<string> {
  const packageDirectory = await realpath(candidate.directory);
  const entryPoint = await realpath(resolve(packageDirectory, candidate.manifest.main));
  const within = relative(packageDirectory, entryPoint);
  if (within === '..' || within.startsWith(`..${sep}`) || within.length === 0) {
    throw new Error('The extension entry point must be a file inside its package directory.');
  }
  return entryPoint;
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
