import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  afterEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { z } from 'zod';

import { appConfigSchema } from './app';
import { Config } from './config';
import { readEnvConfig } from './env';
import { isConfigError } from './error';
import { loadFileSection, loadDirectorySection } from './loader';
import { directorySection, fileSection } from './section';

const created: string[] = [];

async function configDir(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/nox-config-`);
  created.push(dir);
  return dir;
}

async function write(dir: string, name: string, value: unknown): Promise<void> {
  await writeFile(`${dir}/${name}`, JSON.stringify(value, null, 2));
}

async function read(dir: string, name: string): Promise<unknown> {
  return JSON.parse(await readFile(`${dir}/${name}`, 'utf8'));
}

const appSection = fileSection({
  applies: 'restart',
  key: 'app',
  name: 'app.json',
  schema: appConfigSchema,
});

const secretSchema = z.object({
  apiKey: z.string().optional(),
  url: z.string().default('https://example.test'),
});

const secretSection = fileSection({
  applies: 'hot',
  key: 'secret',
  merge: (previous, next) => (
    next.apiKey === undefined && previous.apiKey !== undefined
      ? { ...next, apiKey: previous.apiKey }
      : next
  ),
  name: 'secret.json',
  schema: secretSchema,
});

const blueprintSection = directorySection({
  applies: 'hot',
  entrySchema: z.object({
    name: z.string(),
    temperature: z.number().default(0.7),
  }),
  key: 'blueprints',
  name: 'blueprints',
});

async function init(dir: string): Promise<void> {
  await Config.init(readEnvConfig({ CONFIG_DIR: dir, NODE_ENV: 'test' }));
}

afterEach(async () => {
  Config.reset();
  await Promise.all(created.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe('config files', () => {
  test('writes a complete file from the schema when none exists', async () => {
    const dir = await configDir();

    const value = await loadFileSection(appSection, dir);

    expect(value).toEqual({ logLevel: 'info', server: { host: '127.0.0.1', port: 3000 } });
    expect(await read(dir, 'app.json')).toEqual(value);
  });

  test('materialises settings added in a later version', async () => {
    const dir = await configDir();
    await write(dir, 'app.json', { server: { port: 8080 } });

    const value = await loadFileSection(appSection, dir);

    expect(value.server).toEqual({ host: '127.0.0.1', port: 8080 });
    expect(await read(dir, 'app.json')).toEqual({
      logLevel: 'info',
      server: { host: '127.0.0.1', port: 8080 },
    });
  });

  test('leaves an already complete file untouched', async () => {
    const dir = await configDir();
    const stored = { logLevel: 'warn', server: { host: '0.0.0.0', port: 3000 } };
    await write(dir, 'app.json', stored);
    const before = await readFile(`${dir}/app.json`, 'utf8');

    await loadFileSection(appSection, dir);

    expect(await readFile(`${dir}/app.json`, 'utf8')).toBe(before);
  });

  test('restores defaults for an empty file', async () => {
    const dir = await configDir();
    await writeFile(`${dir}/app.json`, '   ');

    expect(await loadFileSection(appSection, dir)).toMatchObject({ logLevel: 'info' });
  });

  test('rejects broken JSON with the path', async () => {
    const dir = await configDir();
    await writeFile(`${dir}/app.json`, '{ "logLevel": ');

    const error = await loadFileSection(appSection, dir).catch((thrown: unknown) => thrown);
    expect(isConfigError(error) && error.code).toBe('invalid_json');
    expect(String(error)).toContain('app.json');
  });

  test('rejects a value the schema refuses, naming the setting', async () => {
    const dir = await configDir();
    await write(dir, 'app.json', { logLevel: 'chatty' });

    const error = await loadFileSection(appSection, dir).catch((thrown: unknown) => thrown);
    expect(isConfigError(error) && error.code).toBe('invalid_schema');
    expect(String(error)).toContain('logLevel');
  });

  test('rejects an unknown key instead of deleting it on rewrite', async () => {
    const dir = await configDir();
    await write(dir, 'app.json', { logLevle: 'warn' });

    const error = await loadFileSection(appSection, dir).catch((thrown: unknown) => thrown);
    expect(isConfigError(error) && error.code).toBe('unknown_keys');
    expect(String(error)).toContain('logLevle');
    expect(await read(dir, 'app.json')).toEqual({ logLevle: 'warn' });
  });
});

describe('config directories', () => {
  test('creates the directory and reads entries by filename', async () => {
    const dir = await configDir();

    expect(await loadDirectorySection(blueprintSection, dir)).toEqual({});

    await write(dir, 'blueprints/architect.json', { name: 'Architect' });
    const loaded = await loadDirectorySection(blueprintSection, dir);

    expect(loaded).toEqual({ architect: { name: 'Architect', temperature: 0.7 } });
    expect(await read(dir, 'blueprints/architect.json'))
      .toEqual({ name: 'Architect', temperature: 0.7 });
  });
});

describe('config updates', () => {
  test('writes the new value and reports whether a restart is needed', async () => {
    const dir = await configDir();
    await init(dir);

    const result = await Config.update('app', {
      logLevel: 'debug',
      server: { host: '127.0.0.1', port: 3000 },
    });

    expect(result.restartRequired).toBe(true);
    expect(result.value.logLevel).toBe('debug');
    expect(Config.get('app').logLevel).toBe('debug');
    expect(await read(dir, 'app.json')).toMatchObject({ logLevel: 'debug' });
  });

  test('keeps a secret the update left out', async () => {
    const dir = await configDir();
    await write(dir, 'secret.json', { apiKey: 'kept', url: 'https://example.test' });

    const previous = await loadFileSection(secretSection, dir);
    const merged = secretSection.merge?.(previous, { url: 'https://other.test' });

    expect(merged).toEqual({ apiKey: 'kept', url: 'https://other.test' });
  });
});

describe('config lifecycle', () => {
  test('generates every section on a first run', async () => {
    const dir = await configDir();

    await init(dir);

    expect(await read(dir, 'app.json')).toMatchObject({ logLevel: 'info' });
    expect(await read(dir, 'gate.json')).toEqual({
      escalationTimeoutMs: 120_000,
      reviewer: { enabled: false },
      rules: [],
    });
    expect(Config.get('gate').reviewer.enabled).toBe(false);
  });

  test('refuses to be read before it is loaded', () => {
    expect(() => Config.get('app')).toThrow('Config not initialized');
  });
});
