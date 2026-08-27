import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { NoxApplication } from '../application';
import { silentLogger } from '../logger/logger';
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
): void {
  const directory = join(root, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'extension.js'), source);
  writeFileSync(
    join(directory, 'nox-extension.json'),
    JSON.stringify({
      engines,
      id,
      main: 'extension.js',
      schemaVersion: 1,
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
