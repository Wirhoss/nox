import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { silentLogger } from '../logger/logger';
import { appConfigSchema } from './app';
import { Config } from './config';
import { readEnvConfig } from './env';
import { isConfigError } from './error';
import { type LoaderContext, writeJson } from './loader';
import { directorySection, fileSection } from './section';

const created: string[] = [];

const databaseDefaults = { busyTimeoutMs: 5000, path: 'nox.db', synchronous: 'normal' } as const;

async function configDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nox-config-'));
  created.push(directory);
  return directory;
}

function context(directory: string): LoaderContext {
  return { configDir: directory, logger: silentLogger };
}

async function write(directory: string, name: string, value: unknown): Promise<void> {
  await writeFile(join(directory, name), JSON.stringify(value, null, 2));
}

async function read(directory: string, name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(directory, name), 'utf8'));
}

/** Resolves with the error a promise rejected with, or throws if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject, but it resolved.');
}

const appSection = fileSection({
  applies: 'restart',
  name: 'app.json',
  schema: appConfigSchema,
});

const secretSchema = z.object({
  apiKey: z.string().optional(),
  url: z.string().default('https://example.test'),
});

const secretSection = fileSection({
  applies: 'hot',
  // Secrets are read and validated, never rewritten by a plain boot.
  materialize: false,
  merge: (previous, next) => {
    // An omitted key keeps the stored one; an empty one clears it. Without the
    // second rule a key could be set through the API but never removed.
    if (next.apiKey === undefined && previous?.apiKey !== undefined) {
      return { ...next, apiKey: previous.apiKey };
    }
    if (next.apiKey === '') {
      const { apiKey: _cleared, ...rest } = next;
      return rest;
    }
    return next;
  },
  name: 'secret.json',
  schema: secretSchema,
});

const blueprintSection = directorySection({
  applies: 'hot',
  entrySchema: z.object({
    name: z.string(),
    temperature: z.number().default(0.7),
  }),
  name: 'blueprints',
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe('config files', () => {
  test('writes a complete file from the schema when none exists', async () => {
    const dir = await configDir();

    const value = await appSection.load(context(dir));

    expect(value).toEqual({ database: databaseDefaults, logLevel: 'info' });
    expect(await read(dir, 'app.json')).toEqual(value);
  });

  test('materialises settings added in a later version', async () => {
    const dir = await configDir();
    await write(dir, 'app.json', { logLevel: 'warn' });

    const value = await appSection.load(context(dir));

    expect(value.database).toEqual(databaseDefaults);
    expect(await read(dir, 'app.json')).toEqual({
      database: databaseDefaults,
      logLevel: 'warn',
    });
  });

  test('leaves an already complete file untouched', async () => {
    const dir = await configDir();
    await write(dir, 'app.json', { database: databaseDefaults, logLevel: 'warn' });
    const before = await readFile(join(dir, 'app.json'), 'utf8');

    await appSection.load(context(dir));

    expect(await readFile(join(dir, 'app.json'), 'utf8')).toBe(before);
  });

  test('restores defaults for an empty file', async () => {
    const dir = await configDir();
    await writeFile(join(dir, 'app.json'), '   ');

    expect(await appSection.load(context(dir))).toMatchObject({ logLevel: 'info' });
  });

  test('leaves no temporary file behind after a write', async () => {
    const dir = await configDir();

    await appSection.load(context(dir));

    expect(await readdir(dir)).toEqual(['app.json']);
  });

  test('rejects broken JSON with the path', async () => {
    const dir = await configDir();
    await writeFile(join(dir, 'app.json'), '{ "logLevel": ');

    const error = await rejection(appSection.load(context(dir)));

    expect(isConfigError(error) && error.code).toBe('invalid_json');
    expect(String(error)).toContain('app.json');
  });

  test('rejects a value the schema refuses, naming the setting', async () => {
    const dir = await configDir();
    await write(dir, 'app.json', { logLevel: 'chatty' });

    const error = await rejection(appSection.load(context(dir)));

    expect(isConfigError(error) && error.code).toBe('invalid_schema');
    expect(String(error)).toContain('logLevel');
  });

  test('rejects an unknown key instead of deleting it on rewrite', async () => {
    const dir = await configDir();
    await write(dir, 'app.json', { logLevle: 'warn' });

    const error = await rejection(appSection.load(context(dir)));

    expect(isConfigError(error) && error.code).toBe('unknown_keys');
    expect(String(error)).toContain('logLevle');
    expect(await read(dir, 'app.json')).toEqual({ logLevle: 'warn' });
  });
});

describe('config secrets', () => {
  test('a section that does not materialise is never written on load', async () => {
    const dir = await configDir();

    expect(await secretSection.load(context(dir))).toEqual({ url: 'https://example.test' });
    expect(await readdir(dir)).toEqual([]);
  });

  test('keeps a secret the update left out', async () => {
    const dir = await configDir();
    await write(dir, 'secret.json', { apiKey: 'kept', url: 'https://example.test' });

    const value = await secretSection.update(context(dir), { url: 'https://other.test' });

    expect(value).toEqual({ apiKey: 'kept', url: 'https://other.test' });
    expect(await read(dir, 'secret.json')).toEqual(value);
  });

  test('clears a secret set to the empty string', async () => {
    const dir = await configDir();
    await write(dir, 'secret.json', { apiKey: 'kept', url: 'https://example.test' });

    const value = await secretSection.update(context(dir), {
      apiKey: '',
      url: 'https://example.test',
    });

    expect(value).toEqual({ url: 'https://example.test' });
    expect(await read(dir, 'secret.json')).toEqual(value);
  });
});

describe('config directories', () => {
  test('creates the directory and reads entries by filename', async () => {
    const dir = await configDir();

    expect(await blueprintSection.load(context(dir))).toEqual({});

    await write(dir, join('blueprints', 'architect.json'), { name: 'Architect' });
    const loaded = await blueprintSection.load(context(dir));

    expect(loaded).toEqual({ architect: { name: 'Architect', temperature: 0.7 } });
    expect(await read(dir, join('blueprints', 'architect.json'))).toEqual({
      name: 'Architect',
      temperature: 0.7,
    });
  });

  test('refuses entry writes, naming what is missing', async () => {
    const dir = await configDir();

    const error = await rejection(blueprintSection.updateEntry(context(dir), 'architect', {}));

    expect(isConfigError(error) && error.code).toBe('unwritable');
    expect(String(error)).toContain('blueprints');
  });
});

describe('writeJson', () => {
  // Nothing in the application writes one file from twenty callers at once;
  // this pins the utility's own contract, since anything that reaches for an
  // atomic write is entitled to assume racing writers cannot break each other.
  test('racing writers over one path all succeed and leave a readable file', async () => {
    const dir = await configDir();
    const filePath = join(dir, 'app.json');
    const writers = Array.from({ length: 20 }, (_unused, index) => index);

    await Promise.all(writers.map(async (index) => writeJson(filePath, { logLevel: index })));

    const written = (await read(dir, 'app.json')) as { logLevel: number };
    expect(writers).toContain(written.logLevel);
    // Each writer renames its own scratch file into place, so none are orphaned.
    expect(await readdir(dir)).toEqual(['app.json']);
  });
});

describe('Config', () => {
  test('generates every registered section on a first run', async () => {
    const dir = await configDir();

    const config = await Config.load(readEnvConfig({ CONFIG_DIR: dir, NODE_ENV: 'test' }));

    expect(config.env.environment).toBe('test');
    expect(config.get('app')).toEqual({ database: databaseDefaults, logLevel: 'info' });
    expect(await read(dir, 'app.json')).toMatchObject({ logLevel: 'info' });
  });

  test('update writes the new value and reports whether a restart is needed', async () => {
    const dir = await configDir();
    const config = await Config.load(readEnvConfig({ CONFIG_DIR: dir, NODE_ENV: 'test' }));

    const result = await config.update('app', { database: databaseDefaults, logLevel: 'debug' });

    expect(result.restartRequired).toBeTrue();
    expect(result.value.logLevel).toBe('debug');
    expect(config.get('app').logLevel).toBe('debug');
    expect(await read(dir, 'app.json')).toMatchObject({ logLevel: 'debug' });
  });

  test('serialises updates so the stored value matches the file on disk', async () => {
    const dir = await configDir();
    const config = await Config.load(readEnvConfig({ CONFIG_DIR: dir, NODE_ENV: 'test' }));

    const levels = ['debug', 'error', 'info', 'trace', 'warn'] as const;
    const results = await Promise.all(
      levels.map(async (logLevel) =>
        config.update('app', { database: databaseDefaults, logLevel }),
      ),
    );

    // Every caller sees the value it wrote, the last one queued wins in memory,
    // and the file agrees with it: no update lands on disk in one order and in
    // memory in another.
    expect(results.map((result) => result.value.logLevel)).toEqual([...levels]);
    expect(config.get('app').logLevel).toBe('warn');
    expect(await read(dir, 'app.json')).toMatchObject({ logLevel: 'warn' });
  });

  test('two instances over the same directory do not share state', async () => {
    const dir = await configDir();
    const first = await Config.load(readEnvConfig({ CONFIG_DIR: dir, NODE_ENV: 'test' }));
    const second = await Config.load(readEnvConfig({ CONFIG_DIR: dir, NODE_ENV: 'test' }));

    await first.update('app', { database: databaseDefaults, logLevel: 'error' });

    expect(first.get('app').logLevel).toBe('error');
    expect(second.get('app').logLevel).toBe('info');
  });
});

describe('readEnvConfig', () => {
  test('falls back to the installation defaults', () => {
    expect(readEnvConfig({})).toEqual({
      configDir: '/etc/nox/config',
      dataDir: '/var/lib/nox',
      environment: 'development',
    });
  });

  test('rejects an environment it does not know', () => {
    expect(() => readEnvConfig({ NODE_ENV: 'staging' })).toThrow('environment');
  });
});
