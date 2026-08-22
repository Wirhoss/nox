import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { ContributionRegistry } from '../extensions/contribution';
import { providerContribution, providers } from '../extensions/contribution-points/providers';
import { DisposableStore } from '../extensions/disposable';
import { silentLogger } from '../logger/logger';
import { providerBaseConfigSchema } from '../provider/config';
import { appConfigSchema } from './app';
import { blueprintSchema } from './blueprint';
import { Config } from './config';
import { readEnvConfig } from './env';
import { isConfigError } from './error';
import { type LoaderContext, loadSection, updateSection, writeJson } from './loader';
import { directorySection, fileSection } from './section';

import type { ChatProvider } from '../provider/provider';

const created: string[] = [];

const apiDefaults = { host: '0.0.0.0', port: 8080 } as const;
const authDefaults = {
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
  secureCookies: false,
} as const;
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

describe('blueprint config', () => {
  test('materializes agent policy defaults and accepts explicit overrides', () => {
    expect(
      blueprintSchema.parse({ model: 'main-model', provider: 'main', systemPrompt: 'be exact' }),
    ).toEqual({
      context: {},
      description: '',
      generation: {},
      maxIterations: 90,
      model: 'main-model',
      provider: 'main',
      systemPrompt: 'be exact',
      toolSets: { direct: [], routed: [] },
    });

    expect(
      blueprintSchema.parse({
        compaction: { model: 'small-model', provider: 'compact-provider' },
        context: { compactAtRatio: 0.7, reserveForOutput: 1000, contextWindow: 8000 },
        generation: { maxTokens: 1000, temperature: 0.2 },
        maxIterations: 'unlimited',
        model: 'main-model',
        provider: 'main',
        systemPrompt: 'be exact',
        toolSets: { direct: ['clock'], routed: ['internet'] },
      }),
    ).toMatchObject({
      compaction: { model: 'small-model', provider: 'compact-provider' },
      context: { compactAtRatio: 0.7, reserveForOutput: 1000, contextWindow: 8000 },
      generation: { maxTokens: 1000, temperature: 0.2 },
      maxIterations: 'unlimited',
      toolSets: { direct: ['clock'], routed: ['internet'] },
    });

    expect(
      blueprintSchema.safeParse({
        compaction: { model: 'small-model' },
        model: 'main-model',
        provider: 'main',
        systemPrompt: 'be exact',
      }).success,
    ).toBeFalse();
  });
});

describe('config files', () => {
  test('writes a complete file from the schema when none exists', async () => {
    const dir = await configDir();

    const value = await loadSection(appSection, context(dir));

    expect(value).toEqual({
      api: apiDefaults,
      auth: authDefaults,
      chat: {},
      database: databaseDefaults,
      logLevel: 'info',
    });
    expect(await read(dir, 'app.json')).toEqual(value);
  });

  test('materialises settings added in a later version', async () => {
    const dir = await configDir();
    await write(dir, 'app.json', { logLevel: 'warn' });

    const value = await loadSection(appSection, context(dir));

    expect(value.database).toEqual(databaseDefaults);
    expect(await read(dir, 'app.json')).toEqual({
      api: apiDefaults,
      auth: authDefaults,
      chat: {},
      database: databaseDefaults,
      logLevel: 'warn',
    });
  });

  test('leaves an already complete file untouched', async () => {
    const dir = await configDir();
    await write(dir, 'app.json', {
      api: apiDefaults,
      auth: authDefaults,
      chat: {},
      database: databaseDefaults,
      logLevel: 'warn',
    });
    const before = await readFile(join(dir, 'app.json'), 'utf8');

    await loadSection(appSection, context(dir));

    expect(await readFile(join(dir, 'app.json'), 'utf8')).toBe(before);
  });

  test('restores defaults for an empty file', async () => {
    const dir = await configDir();
    await writeFile(join(dir, 'app.json'), '   ');

    expect(await loadSection(appSection, context(dir))).toMatchObject({ logLevel: 'info' });
  });

  test('leaves no temporary file behind after a write', async () => {
    const dir = await configDir();

    await loadSection(appSection, context(dir));

    expect(await readdir(dir)).toEqual(['app.json']);
  });

  test('rejects broken JSON with the path', async () => {
    const dir = await configDir();
    await writeFile(join(dir, 'app.json'), '{ "logLevel": ');

    const error = await rejection(loadSection(appSection, context(dir)));

    expect(isConfigError(error) && error.code).toBe('invalid_json');
    expect(String(error)).toContain('app.json');
  });

  test('rejects a value the schema refuses, naming the setting', async () => {
    const dir = await configDir();
    await write(dir, 'app.json', { logLevel: 'chatty' });

    const error = await rejection(loadSection(appSection, context(dir)));

    expect(isConfigError(error) && error.code).toBe('invalid_schema');
    expect(String(error)).toContain('logLevel');
  });

  test('rejects an unknown key instead of deleting it on rewrite', async () => {
    const dir = await configDir();
    await write(dir, 'app.json', { logLevle: 'warn' });

    const error = await rejection(loadSection(appSection, context(dir)));

    expect(isConfigError(error) && error.code).toBe('unknown_keys');
    expect(String(error)).toContain('logLevle');
    expect(await read(dir, 'app.json')).toEqual({ logLevle: 'warn' });
  });
});

describe('config secrets', () => {
  test('a section that does not materialise is never written on load', async () => {
    const dir = await configDir();

    expect(await loadSection(secretSection, context(dir))).toEqual({ url: 'https://example.test' });
    expect(await readdir(dir)).toEqual([]);
  });

  test('keeps a secret the update left out', async () => {
    const dir = await configDir();
    await write(dir, 'secret.json', { apiKey: 'kept', url: 'https://example.test' });

    const previous = await loadSection(secretSection, context(dir));
    const value = await updateSection(
      secretSection,
      context(dir),
      { url: 'https://other.test' },
      previous,
    );

    expect(value).toEqual({ apiKey: 'kept', url: 'https://other.test' });
    expect(await read(dir, 'secret.json')).toEqual(value);
  });

  test('clears a secret set to the empty string', async () => {
    const dir = await configDir();
    await write(dir, 'secret.json', { apiKey: 'kept', url: 'https://example.test' });

    const previous = await loadSection(secretSection, context(dir));
    const value = await updateSection(
      secretSection,
      context(dir),
      { apiKey: '', url: 'https://example.test' },
      previous,
    );

    expect(value).toEqual({ url: 'https://example.test' });
    expect(await read(dir, 'secret.json')).toEqual(value);
  });
});

describe('config directories', () => {
  test('creates the directory and reads entries by filename', async () => {
    const dir = await configDir();

    expect(await loadSection(blueprintSection, context(dir))).toEqual({});

    await write(dir, join('blueprints', 'architect.json'), { name: 'Architect' });
    const loaded = await loadSection(blueprintSection, context(dir));

    expect(loaded).toEqual({ architect: { name: 'Architect', temperature: 0.7 } });
    expect(await read(dir, join('blueprints', 'architect.json'))).toEqual({
      name: 'Architect',
      temperature: 0.7,
    });
  });

  test('refuses a whole-document write, pointing at the entries', async () => {
    const dir = await configDir();

    const error = await rejection(updateSection(blueprintSection, context(dir), {}, undefined));

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
    expect(config.get('app')).toEqual({
      api: apiDefaults,
      auth: authDefaults,
      chat: {},
      database: databaseDefaults,
      logLevel: 'info',
    });
    expect(await read(dir, 'app.json')).toMatchObject({ logLevel: 'info' });
  });

  test('update writes the new value and reports whether a restart is needed', async () => {
    const dir = await configDir();
    const config = await Config.load(readEnvConfig({ CONFIG_DIR: dir, NODE_ENV: 'test' }));

    const result = await config.update('app', {
      api: apiDefaults,
      auth: authDefaults,
      chat: {},
      database: databaseDefaults,
      logLevel: 'debug',
    });

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
        config.update('app', {
          api: apiDefaults,
          auth: authDefaults,
          chat: {},
          database: databaseDefaults,
          logLevel,
        }),
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

    await first.update('app', {
      api: apiDefaults,
      auth: authDefaults,
      chat: {},
      database: databaseDefaults,
      logLevel: 'error',
    });

    expect(first.get('app').logLevel).toBe('error');
    expect(second.get('app').logLevel).toBe('info');
  });
});

/** A provider kind that exists only here, to prove the union is built from the
 *  registry rather than from anything the kernel imported. */
const fakeSchema = providerBaseConfigSchema.extend({ type: z.literal('fake_provider') });

function registryWith(...ids: string[]): ContributionRegistry {
  const registry = new ContributionRegistry();
  const scoped = registry.scoped('test.extension', new DisposableStore());
  for (const id of ids) {
    scoped.register(
      providers,
      id,
      providerContribution({
        configSchema: providerBaseConfigSchema.extend({ type: z.literal(id) }),
        create: () => ({}) as unknown as ChatProvider,
      }),
    );
  }
  return registry;
}

async function loadedConfig(dir: string): Promise<Config> {
  return Config.load(readEnvConfig({ CONFIG_DIR: dir, NODE_ENV: 'test' }), {
    logger: silentLogger,
  });
}

describe('contributed sections', () => {
  test('has no value before the extensions that describe it have activated', async () => {
    const dir = await configDir();
    const config = await loadedConfig(dir);

    // Not an empty value, which would be a wrong answer rather than no answer:
    // the schema does not exist yet, so neither does the section.
    expect(config.loaded).toEqual(['app', 'blueprints']);
    expect(() => config.get('providers')).toThrow('resolve');
  });

  test('validates entries against the schema each contribution declared', async () => {
    const dir = await configDir();
    await write(dir, 'providers.json', {
      local: { baseUrl: 'https://local.test', type: 'fake_provider' },
    });
    const config = await loadedConfig(dir);

    await config.resolve(registryWith('fake_provider'));

    expect(config.get('providers')).toEqual({
      local: {
        baseUrl: 'https://local.test',
        maxRetries: 2,
        maxRetryDelayMs: 30_000,
        retryDelayMs: 500,
        type: 'fake_provider',
      },
    });
    expect(await read(dir, 'providers.json')).toEqual(config.get('providers'));
  });

  test('holds several instances of one kind, told apart by their key', async () => {
    const dir = await configDir();
    await write(dir, 'providers.json', {
      one: { baseUrl: 'https://one.test', type: 'fake_provider' },
      two: { baseUrl: 'https://two.test', type: 'fake_provider' },
    });
    const config = await loadedConfig(dir);

    await config.resolve(registryWith('fake_provider'));

    expect(Object.keys(config.get('providers'))).toEqual(['one', 'two']);
  });

  test('rejects a kind nobody registered, naming the kinds there are', async () => {
    const dir = await configDir();
    await write(dir, 'providers.json', { local: { baseUrl: 'https://x.test', type: 'ghost' } });
    const config = await loadedConfig(dir);

    const error = await rejection(config.resolve(registryWith('fake_provider')));

    expect(isConfigError(error) && error.code).toBe('invalid_schema');
    expect(String(error)).toContain('fake_provider');
  });

  test('rejects every entry when nothing is registered at the point', async () => {
    const dir = await configDir();
    await write(dir, 'providers.json', { local: { baseUrl: 'https://x.test', type: 'ghost' } });
    const config = await loadedConfig(dir);

    const error = await rejection(config.resolve(new ContributionRegistry()));

    expect(String(error)).toContain('nox.providers');
  });

  test('generates an empty file so there is something to configure', async () => {
    const dir = await configDir();
    const config = await loadedConfig(dir);

    await config.resolve(registryWith('fake_provider'));

    expect(config.get('providers')).toEqual({});
    expect(await read(dir, 'providers.json')).toEqual({});
  });

  test('an update is validated against the registry too', async () => {
    const dir = await configDir();
    const config = await loadedConfig(dir);
    await config.resolve(registryWith('fake_provider'));

    const result = await config.update('providers', {
      local: {
        baseUrl: 'https://local.test',
        maxRetries: 2,
        maxRetryDelayMs: 30_000,
        retryDelayMs: 500,
        type: 'fake_provider',
      },
    });

    expect(result.restartRequired).toBeTrue();
    expect(await read(dir, 'providers.json')).toEqual(result.value);
  });

  test('refuses a contribution whose discriminator is not its own ID', () => {
    const scoped = new ContributionRegistry().scoped('test.extension', new DisposableStore());

    expect(() =>
      scoped.register(
        providers,
        'renamed',
        providerContribution({ configSchema: fakeSchema, create: () => ({}) as ChatProvider }),
      ),
    ).toThrow('fake_provider');
  });
});

describe('readEnvConfig', () => {
  test('falls back to the installation defaults', () => {
    expect(readEnvConfig({})).toEqual({
      configDir: '/etc/nox/config',
      dataDir: '/var/lib/nox',
      environment: 'development',
      uiDir: '/app/ui',
    });
  });

  test('rejects an environment it does not know', () => {
    expect(() => readEnvConfig({ NODE_ENV: 'staging' })).toThrow('environment');
  });
});
