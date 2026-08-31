import { readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

import { HOST_PROVIDED_PACKAGES } from '@nox/extension-api';
import { satisfies } from 'semver';

/**
 * What the host actually has installed, for the packages it says it provides.
 *
 * Read from disk rather than from Nox's own `package.json`, because the two can
 * disagree: a range in a manifest is a wish, and the file beside the resolved
 * module is what will be imported. A package Nox declares but cannot resolve is
 * absent here, which is the same answer an extension would get at runtime.
 *
 * Resolved once. The set cannot change while the process runs, and an extension
 * checked against a different answer than the previous one was checked against
 * would make load order matter.
 */
let resolved: ReadonlyMap<string, string> | undefined;

function packageVersion(name: string, from: string): string | undefined {
  let directory: string;
  try {
    directory = dirname(Bun.resolveSync(name, from));
  } catch {
    return undefined;
  }

  // Up from the resolved entry file to the package's own manifest. The entry
  // can sit several directories deep — `dist/index.mjs` is ordinary — and the
  // first `package.json` that names this package is the one that owns it.
  const { root } = parse(directory);
  while (directory !== root) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        readonly name?: unknown;
        readonly version?: unknown;
      };
      if (manifest.name === name && typeof manifest.version === 'string') return manifest.version;
    } catch {
      // Not this directory; keep walking.
    }
    directory = dirname(directory);
  }
  return undefined;
}

function hostPackageVersions(): ReadonlyMap<string, string> {
  if (resolved !== undefined) return resolved;
  const versions = new Map<string, string>();
  for (const name of HOST_PROVIDED_PACKAGES) {
    const version = packageVersion(name, process.cwd());
    if (version !== undefined) versions.set(name, version);
  }
  resolved = versions;
  return versions;
}

/**
 * Why an extension's declared host packages cannot be satisfied, or undefined.
 *
 * Answered at discovery, beside the `engines` checks it is modelled on, so a
 * package that cannot get the library it needs is reported as incompatible with
 * this installation — not discovered when the first tool call throws a module
 * resolution error at whoever happened to be talking to Nox at the time.
 */
function unsatisfiedHostPackages(
  declared: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (declared === undefined) return undefined;
  const installed = hostPackageVersions();
  const problems: string[] = [];
  for (const [name, range] of Object.entries(declared)) {
    const version = installed.get(name);
    if (version === undefined) {
      problems.push(`${name} is not provided by this Nox`);
      continue;
    }
    if (!satisfies(version, range, { includePrerelease: true })) {
      problems.push(`${name} ${range} is required; this Nox provides ${version}`);
    }
  }
  return problems.length === 0 ? undefined : problems.join('; ');
}

export { hostPackageVersions, unsatisfiedHostPackages };
