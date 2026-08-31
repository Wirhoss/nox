import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { NoxApplication } from '../application';
import { silentLogger } from '../logger/logger';
import { hostPackageVersions } from './hostPackages';
import { discoverExtensions } from './loader';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      /* Windows may retain a just-imported module briefly. */
    }
  }
});

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function install(
  root: string,
  id: string,
  source = 'export default { activate() {} };',
  engines: { extensionApi: string; nox: string } = { extensionApi: '^0.1.0', nox: '^0.1.0' },
  hostPackages?: Record<string, string>,
  services?: readonly string[],
): void {
  const directory = join(root, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'extension.js'), source);
  writeFileSync(
    join(directory, 'nox-extension.json'),
    JSON.stringify({
      engines,
      ...(hostPackages === undefined ? {} : { hostPackages }),
      id,
      main: 'extension.js',
      schemaVersion: 1,
      ...(services === undefined ? {} : { services }),
      version: '1.2.3',
    }),
  );
}

async function discover(builtin: string, installed: string) {
  return discoverExtensions({
    directories: [
      { directory: builtin, origin: 'builtin' },
      { directory: installed, origin: 'installed' },
    ],
    logger: silentLogger,
    noxVersion: '0.1.0',
  });
}

describe('discoverExtensions', () => {
  test('loads builtin and installed packages through the same path', async () => {
    const builtin = temporary('nox-builtin-');
    const installed = temporary('nox-installed-');
    install(builtin, 'test.builtin');
    install(installed, 'test.installed');

    const discovered = await discover(builtin, installed);
    const app = new NoxApplication({ extensions: discovered.extensions });
    await app.start();

    expect(discovered.extensions.map(({ manifest }) => manifest.id)).toEqual([
      'test.builtin',
      'test.installed',
    ]);
    expect(discovered.catalog.list()).toEqual([
      {
        contributions: [],
        id: 'test.builtin',
        origin: 'builtin',
        state: 'active',
        version: '1.2.3',
      },
      {
        contributions: [],
        id: 'test.installed',
        origin: 'installed',
        state: 'active',
        version: '1.2.3',
      },
    ]);
    await app.stop();
  });

  test('keeps incompatible Nox and API ranges out of activation', async () => {
    const builtin = temporary('nox-builtin-');
    const installed = temporary('nox-installed-');
    install(builtin, 'test.future-nox', undefined, { extensionApi: '*', nox: '^2.0.0' });
    install(installed, 'test.future-api', undefined, { extensionApi: '^2.0.0', nox: '*' });

    const discovered = await discover(builtin, installed);

    expect(discovered.extensions).toHaveLength(0);
    expect(discovered.catalog.list().map(({ state }) => state)).toEqual([
      'incompatible',
      'incompatible',
    ]);
    expect(discovered.catalog.list()[0]?.error).toContain('Extension API');
    expect(discovered.catalog.list()[1]?.error).toContain('Nox');
  });

  // A library the host cannot supply is settled with the engine checks, at the
  // one moment the answer is cheap. The alternative is a package that activates,
  // contributes, and throws a module resolution error at whoever is talking to
  // Nox when its first tool call lands.
  test('keeps a package out when the host cannot satisfy the library it needs', async () => {
    const builtin = temporary('nox-builtin-');
    const installed = temporary('nox-installed-');
    install(builtin, 'test.old-zod', undefined, { extensionApi: '*', nox: '*' }, { zod: '^2.0.0' });
    install(
      installed,
      'test.current-zod',
      undefined,
      { extensionApi: '*', nox: '*' },
      {
        zod: `^${hostPackageVersions().get('zod') ?? '0.0.0'}`,
      },
    );

    const discovered = await discover(builtin, installed);

    expect(discovered.extensions.map(({ manifest }) => manifest.id)).toEqual(['test.current-zod']);
    const rejected = discovered.catalog.list().find(({ id }) => id === 'test.old-zod');
    expect(rejected?.state).toBe('incompatible');
    expect(rejected?.error).toContain('zod ^2.0.0 is required');
  });

  // The escalation this closes is concrete: an installed package calling itself
  // `nox.impostor` owns `nox.impostor.*`, and an operator's existing grant of
  // `nox.*` — written to mean "the core's own" — already covers it. Nothing
  // downstream can tell the two apart, because the ID is the only evidence.
  test('refuses an installed package that claims the core namespace', async () => {
    const builtin = temporary('nox-builtin-');
    const installed = temporary('nox-installed-');
    install(builtin, 'nox.toolset.real');
    install(installed, 'nox.impostor');

    const discovered = await discover(builtin, installed);

    expect(discovered.extensions.map(({ manifest }) => manifest.id)).toEqual(['nox.toolset.real']);
    const refused = discovered.catalog.list().find(({ id }) => id === 'nox.impostor');
    expect(refused?.state).toBe('failed');
    expect(refused?.error).toContain('reserved');
  });

  // The reservation is a namespace, not a substring: `noxious.tools` is
  // somebody's package and shares nothing with `nox.` but three letters.
  test('leaves an installed package under its own namespace alone', async () => {
    const builtin = temporary('nox-builtin-');
    const installed = temporary('nox-installed-');
    install(installed, 'acme.tools');
    install(installed, 'noxious.tools');

    const discovered = await discover(builtin, installed);

    expect(discovered.extensions.map(({ manifest }) => manifest.id).sort()).toEqual([
      'acme.tools',
      'noxious.tools',
    ]);
  });

  test('binds the origin a package was found under, so nothing it ships can change it', async () => {
    const builtin = temporary('nox-builtin-');
    const installed = temporary('nox-installed-');
    install(builtin, 'nox.toolset.real');
    install(installed, 'acme.tools');

    const discovered = await discover(builtin, installed);

    expect(Object.fromEntries(discovered.extensions.map((e) => [e.manifest.id, e.origin]))).toEqual(
      { 'acme.tools': 'installed', 'nox.toolset.real': 'builtin' },
    );
  });

  // A declaration nobody can read is not a disclosure. This is the one place an
  // operator sees what an installed package reaches for without opening its
  // manifest by hand.
  test('reports what each package declared, alongside what it is', async () => {
    const builtin = temporary('nox-builtin-');
    const installed = temporary('nox-installed-');
    install(
      installed,
      'acme.tools',
      undefined,
      { extensionApi: '*', nox: '*' },
      { zod: `^${hostPackageVersions().get('zod') ?? '0.0.0'}` },
      ['nox.artifact-pipeline'],
    );

    const discovered = await discover(builtin, installed);

    expect(discovered.catalog.list().find(({ id }) => id === 'acme.tools')).toMatchObject({
      origin: 'installed',
      services: ['nox.artifact-pipeline'],
      state: 'loaded',
    });
  });

  // Reported most of all when the package did not load: an unsatisfiable range
  // is the likeliest reason it did not, and an error without the declaration
  // leaves the reader with nothing to act on.
  test('still reports the declarations of a package it turned away', async () => {
    const builtin = temporary('nox-builtin-');
    const installed = temporary('nox-installed-');
    install(
      installed,
      'acme.tools',
      undefined,
      { extensionApi: '*', nox: '*' },
      {
        zod: '^2.0.0',
      },
    );

    const discovered = await discover(builtin, installed);

    const entry = discovered.catalog.list().find(({ id }) => id === 'acme.tools');
    expect(entry?.state).toBe('incompatible');
    expect(entry?.hostPackages).toEqual({ zod: '^2.0.0' });
  });

  // The scoped container already refuses this, but only when asked — and the
  // asking can be buried in a `create` that runs when somebody edits config
  // hours later. Answered at discovery instead, from the manifest alone.
  test('turns away an installed package that declares a control-plane service', async () => {
    const builtin = temporary('nox-builtin-');
    const installed = temporary('nox-installed-');
    install(builtin, 'nox.toolset.config', undefined, { extensionApi: '*', nox: '*' }, undefined, [
      'nox.config-admin',
    ]);
    install(installed, 'acme.tools', undefined, { extensionApi: '*', nox: '*' }, undefined, [
      'nox.config-admin',
    ]);
    install(installed, 'acme.honest', undefined, { extensionApi: '*', nox: '*' }, undefined, [
      'nox.artifact-pipeline',
    ]);

    const discovered = await discover(builtin, installed);

    // The one package is refused; everything else, builtin and installed
    // alike, rolls forward. Nox does not fall over for a bad neighbour.
    expect(discovered.extensions.map(({ manifest }) => manifest.id).sort()).toEqual([
      'acme.honest',
      'nox.toolset.config',
    ]);
    const refused = discovered.catalog.list().find(({ id }) => id === 'acme.tools');
    expect(refused?.state).toBe('failed');
    expect(refused?.error).toContain('reserved to Nox builtins');
    // Still disclosed: what it asked for is exactly what the reader needs.
    expect(refused?.services).toEqual(['nox.config-admin']);
  });

  test('isolates activation failure and rolls forward healthy packages', async () => {
    const builtin = temporary('nox-builtin-');
    const installed = temporary('nox-installed-');
    install(builtin, 'test.broken', 'export default { activate() { throw new Error("boom"); } };');
    install(installed, 'test.healthy');

    const discovered = await discover(builtin, installed);
    const app = new NoxApplication({ extensions: discovered.extensions });
    await app.start();

    expect(app.state).toBe('running');
    expect(discovered.catalog.list().map(({ id, state }) => ({ id, state }))).toEqual([
      { id: 'test.broken', state: 'failed' },
      { id: 'test.healthy', state: 'active' },
    ]);
    expect(discovered.catalog.list()[0]?.error).toBe('boom');
    await app.stop();
  });

  test('rejects every duplicate instead of choosing an origin as privileged', async () => {
    const builtin = temporary('nox-builtin-');
    const installed = temporary('nox-installed-');
    install(builtin, 'test.same');
    install(installed, 'test.same');

    const discovered = await discover(builtin, installed);

    expect(discovered.extensions).toHaveLength(0);
    expect(discovered.catalog.list()).toHaveLength(2);
    expect(discovered.catalog.list().every(({ state }) => state === 'failed')).toBeTrue();
    expect(
      discovered.catalog.list().every(({ error }) => error?.includes('more than once') ?? false),
    ).toBeTrue();
  });
});
