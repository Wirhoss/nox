import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  httpProviderConfigSchema,
  providerBaseConfigSchema,
  providerContribution,
  providers,
  toolSetBaseConfigSchema,
  toolSetContribution,
  toolSets,
} from '@nox/extension-api';
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { ContributionRegistry } from '../extensions/contribution';
import { DisposableStore } from '../extensions/disposable';
import { silentLogger } from '../logger/logger';
import { appConfigSchema } from './app';
import { blueprintSchema } from './blueprint';
import { Config } from './config';
import { readEnvConfig } from './env';
import { isConfigError } from './error';
import { loadSection, removeEntry, updateEntry, updateSection, writeJson } from './loader';
import { directorySection, fileSection } from './section';

import type { LoaderContext } from './loader';
import type { ChatProvider, ToolSet } from '@nox/extension-api';

const created: string[] = [];

const apiDefaults = { host: '0.0.0.0', port: 8080 } as const;
const artifactDefaults = {
  maxArtifactBytes: 100 * 1024 * 1024,
  maxStorageBytes: 10 * 1024 * 1024 * 1024,
} as const;
const authDefaults = {
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
  secureCookies: false,
} as const;
const databaseDefaults = { busyTimeoutMs: 5000, path: 'nox.db', synchronous: 'normal' } as const;
const uiDefaults = { locale: 'en' } as const;

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
      taskModels: {},
      provider: 'main',
      systemPrompt: 'be exact',
      toolSets: { direct: [], routed: [] },
    });

    expect(
      blueprintSchema.parse({
        context: { compactAtRatio: 0.7, reserveForOutput: 1000, contextWindow: 8000 },
        generation: { maxTokens: 1000, temperature: 0.2 },
        maxIterations: 'unlimited',
        model: 'main-model',
        taskModels: {
          compaction: { model: 'small-model', provider: 'compact-provider' },
          // A task may name only a model; it stays on the agent's provider.
          title: { model: 'tiny-model' },
        },
        provider: 'main',
        systemPrompt: 'be exact',
        toolSets: { direct: ['clock'], routed: ['internet'] },
      }),
    ).toMatchObject({
      context: { compactAtRatio: 0.7, reserveForOutput: 1000, contextWindow: 8000 },
      generation: { maxTokens: 1000, temperature: 0.2 },
      maxIterations: 'unlimited',
      taskModels: {
        compaction: { model: 'small-model', provider: 'compact-provider' },
        title: { model: 'tiny-model' },
      },
      toolSets: { direct: ['clock'], routed: ['internet'] },
    });

    // A provider without a model names nothing: which model to run the task on
    // is the whole question the entry exists to answer.
    expect(
      blueprintSchema.safeParse({
        model: 'main-model',
        taskModels: { title: { provider: 'other' } },
        provider: 'main',
        systemPrompt: 'be exact',
      }).success,
    ).toBeFalse();
  });

  test('grants a whole tool set by name, or an allowlist over one', () => {
    const parsed = blueprintSchema.parse({
      model: 'main-model',
      provider: 'main',
      systemPrompt: 'be exact',
      toolSets: {
        direct: ['clock', { id: 'files', tools: ['read_file', 'list_dir'] }],
        routed: [{ id: 'internet' }],
      },
    });

    // Both forms survive as written. Normalizing the bare string into an object
    // here would make every blueprint on disk differ from its parsed value, and
    // the loader rewrites a file when those differ.
    expect(parsed.toolSets).toEqual({
      direct: ['clock', { id: 'files', tools: ['read_file', 'list_dir'] }],
      routed: [{ id: 'internet' }],
    });
  });

  test('refuses a grant of a set and none of its tools', () => {
    // It reads exactly like the grant that means "all of them", so it is a
    // mistake rather than a policy anyone wrote on purpose.
    expect(
      blueprintSchema.safeParse({
        model: 'main-model',
        provider: 'main',
        systemPrompt: 'be exact',
        toolSets: { direct: [{ id: 'files', tools: [] }] },
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
      artifacts: artifactDefaults,
      auth: authDefaults,
      database: databaseDefaults,
      logLevel: 'info',
      timezone: 'UTC',
      ui: uiDefaults,
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
      artifacts: artifactDefaults,
      auth: authDefaults,
      database: databaseDefaults,
      logLevel: 'warn',
      timezone: 'UTC',
      ui: uiDefaults,
    });
  });

  test('refuses an artifact quota smaller than one allowed artifact', async () => {
    const dir = await configDir();
    await write(dir, 'app.json', {
      artifacts: { maxArtifactBytes: 1024, maxStorageBytes: 512 },
    });

    expect(loadSection(appSection, context(dir))).rejects.toThrow(
      /storage must hold at least one maximum-sized artifact/iu,
    );
  });

  test('refuses a time zone the runtime has never heard of', async () => {
    const dir = await configDir();
    await write(dir, 'app.json', { timezone: 'Mars/Olympus' });

    // Caught at load, where an operator can still read which line is wrong,
    // rather than at the first message stamped with it.
    expect(loadSection(appSection, context(dir))).rejects.toThrow(/IANA time zone/u);
  });

  test('keeps a configured time zone as written', async () => {
    const dir = await configDir();
    await write(dir, 'app.json', { timezone: 'America/Mexico_City' });

    expect(await loadSection(appSection, context(dir))).toMatchObject({
      timezone: 'America/Mexico_City',
    });
  });

  test('normalizes the configured interface locale', async () => {
    const dir = await configDir();
    await write(dir, 'app.json', { ui: { locale: 'ES' } });

    const value = await loadSection(appSection, context(dir));

    expect(value).toMatchObject({ ui: { locale: 'es' } });
    expect(await read(dir, 'app.json')).toMatchObject({ ui: { locale: 'es' } });
  });

  test('leaves an already complete file untouched', async () => {
    const dir = await configDir();
    await write(dir, 'app.json', {
      api: apiDefaults,
      artifacts: artifactDefaults,
      auth: authDefaults,
      database: databaseDefaults,
      logLevel: 'warn',
      timezone: 'UTC',
      ui: uiDefaults,
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

  test('writes and removes one entry without touching its neighbours', async () => {
    const dir = await configDir();

    await updateEntry(blueprintSection, context(dir), 'architect', { name: 'Architect' });
    await updateEntry(blueprintSection, context(dir), 'watcher', { name: 'Watcher' });

    expect(await loadSection(blueprintSection, context(dir))).toEqual({
      architect: { name: 'Architect', temperature: 0.7 },
      watcher: { name: 'Watcher', temperature: 0.7 },
    });

    expect(await removeEntry(blueprintSection, context(dir), 'watcher')).toBeTrue();
    expect(await loadSection(blueprintSection, context(dir))).toEqual({
      architect: { name: 'Architect', temperature: 0.7 },
    });

    // Removing what is not there is what the caller asked for either way.
    expect(await removeEntry(blueprintSection, context(dir), 'watcher')).toBeFalse();
  });

  test('validates an entry against the section schema before writing it', async () => {
    const dir = await configDir();

    const error = await rejection(
      updateEntry(blueprintSection, context(dir), 'broken', { temperature: 'warm' }),
    );

    expect(isConfigError(error) && error.code).toBe('invalid_schema');
    expect(await loadSection(blueprintSection, context(dir))).toEqual({});
  });

  test('leaves nothing behind when the caller refuses the parsed entry', async () => {
    const dir = await configDir();

    // The hook is how a caller checks what the entry's own schema cannot: that
    // the rest of the configuration agrees with it.
    const error = await rejection(
      updateEntry(blueprintSection, context(dir), 'refused', { name: 'Refused' }, () => {
        throw new Error('the provider it names is not configured');
      }),
    );

    expect(String(error)).toContain('not configured');
    expect(await loadSection(blueprintSection, context(dir))).toEqual({});
  });

  test('refuses an entry ID that would escape the section directory', async () => {
    const dir = await configDir();

    // The ID becomes a file name, so it is checked rather than trusted.
    for (const entryId of ['../escaped', 'nested/child', '.hidden', '']) {
      const error = await rejection(
        updateEntry(blueprintSection, context(dir), entryId, { name: 'Nope' }),
      );
      expect(isConfigError(error) && error.code).toBe('unwritable');
    }
  });
});

describe('config directory entries through Config', () => {
  test('reflects a hot written entry in the value it hands out', async () => {
    const dir = await configDir();
    const config = await loadedConfig(dir);

    const saved = await config.updateEntry('blueprints', 'watcher', {
      model: 'main-model',
      provider: 'main',
      systemPrompt: 'watch',
    });

    // Agent generations reconcile after the write; the desired document does
    // not require the process itself to restart.
    expect(saved.restartRequired).toBeFalse();
    expect(saved.value.systemPrompt).toBe('watch');
    expect(Object.keys(config.get('blueprints'))).toEqual(['watcher']);

    expect(await config.removeEntry('blueprints', 'watcher')).toBeTrue();
    expect(config.get('blueprints')).toEqual({});

    // And the directory is the record: a fresh load agrees with what is held.
    expect((await loadedConfig(dir)).get('blueprints')).toEqual({});
  });

  test('holds the previous entry when a write is refused', async () => {
    const dir = await configDir();
    const config = await loadedConfig(dir);
    await config.updateEntry('blueprints', 'nox', {
      model: 'main-model',
      provider: 'main',
      systemPrompt: 'be exact',
    });

    const error = await rejection(
      config.updateEntry('blueprints', 'nox', { model: 'main-model', provider: 'main' }),
    );

    expect(isConfigError(error) && error.code).toBe('invalid_schema');
    expect(config.get('blueprints').nox?.systemPrompt).toBe('be exact');
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
      artifacts: artifactDefaults,
      auth: authDefaults,
      database: databaseDefaults,
      logLevel: 'info',
      timezone: 'UTC',
      ui: uiDefaults,
    });
    expect(await read(dir, 'app.json')).toMatchObject({ logLevel: 'info' });
  });

  test('update writes the new value and reports whether a restart is needed', async () => {
    const dir = await configDir();
    const config = await Config.load(readEnvConfig({ CONFIG_DIR: dir, NODE_ENV: 'test' }));

    const result = await config.update('app', {
      api: apiDefaults,
      artifacts: artifactDefaults,
      auth: authDefaults,
      database: databaseDefaults,
      logLevel: 'debug',
      timezone: 'UTC',
      ui: uiDefaults,
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
          artifacts: artifactDefaults,
          auth: authDefaults,
          database: databaseDefaults,
          logLevel,
          timezone: 'UTC',
          ui: uiDefaults,
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
      artifacts: artifactDefaults,
      auth: authDefaults,
      database: databaseDefaults,
      logLevel: 'error',
      timezone: 'UTC',
      ui: uiDefaults,
    });

    expect(first.get('app').logLevel).toBe('error');
    expect(second.get('app').logLevel).toBe('info');
  });
});

/** A provider kind that exists only here, to prove the union is built from the
 *  registry rather than from anything the kernel imported. */
const fakeSchema = httpProviderConfigSchema.extend({ type: z.literal('fake_provider') });

function registryWith(...ids: string[]): ContributionRegistry {
  const registry = new ContributionRegistry();
  const scoped = registry.scoped('test.extension', new DisposableStore());
  for (const id of ids) {
    scoped.register(
      providers,
      id,
      providerContribution({
        instances: 'many',
        configSchema: httpProviderConfigSchema.extend({ type: z.literal(id) }),
        create: () => ({}) as unknown as ChatProvider,
      }),
    );
  }
  return registry;
}

function singletonRegistry(id: string): ContributionRegistry {
  const registry = new ContributionRegistry();
  const scoped = registry.scoped('test.extension', new DisposableStore());
  scoped.register(
    providers,
    id,
    providerContribution({
      configSchema: httpProviderConfigSchema.extend({ type: z.literal(id) }),
      create: () => ({}) as unknown as ChatProvider,
    }),
  );
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

    expect(config.get('providers') as Record<string, unknown>).toEqual({
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

  test('configures a provider that has no endpoint to name', async () => {
    const dir = await configDir();
    await write(dir, 'providers.json', { in_process: { type: 'in_process' } });
    const config = await loadedConfig(dir);
    const registry = new ContributionRegistry();
    registry.scoped('test.extension', new DisposableStore()).register(
      providers,
      'in_process',
      providerContribution({
        configSchema: providerBaseConfigSchema.extend({ type: z.literal('in_process') }),
        create: () => ({}) as unknown as ChatProvider,
      }),
    );

    await config.resolve(registry);

    // The point of the split: a provider holding its model in this process has
    // no URL to give, and configuration no longer makes it invent one.
    expect(Object.keys(config.get('providers'))).toEqual(['in_process']);
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

    const desired = {
      local: {
        baseUrl: 'https://local.test',
        maxRetries: 2,
        maxRetryDelayMs: 30_000,
        retryDelayMs: 500,
        type: 'fake_provider',
      },
    };
    const result = await config.update('providers', desired);

    expect(result.restartRequired).toBeFalse();
    expect(await read(dir, 'providers.json')).toEqual(result.value);
  });

  test('refuses a contribution whose discriminator is not its own ID', () => {
    const scoped = new ContributionRegistry().scoped('test.extension', new DisposableStore());

    expect(() =>
      scoped.register(
        providers,
        'renamed',
        providerContribution({
          instances: 'many',
          configSchema: fakeSchema,
          create: () => ({}) as ChatProvider,
        }),
      ),
    ).toThrow('fake_provider');
  });
});

describe('readEnvConfig', () => {
  test('falls back to the installation defaults', () => {
    expect(readEnvConfig({})).toEqual({
      configDir: '/etc/nox/config',
      configWatch: false,
      configWatchDebounceMs: 250,
      dataDir: '/var/lib/nox',
      environment: 'development',
      extensionsDir: join('/var/lib/nox', 'extensions'),
      uiDir: '/app/ui',
    });
  });

  test('does not expose a builtin extension directory override', () => {
    expect(readEnvConfig({ BUILTIN_EXTENSIONS_DIR: '/tmp/pretend-builtins' })).not.toHaveProperty(
      'builtinExtensionsDir',
    );
  });

  test('rejects an environment it does not know', () => {
    expect(() => readEnvConfig({ NODE_ENV: 'staging' })).toThrow('environment');
  });
});

describe('how many instances a contribution has', () => {
  test('lets a many-instance contribution be configured under any name, twice', async () => {
    const dir = await configDir();
    await write(dir, 'providers.json', {
      backup: { baseUrl: 'https://b.test', type: 'fake_provider' },
      main: { baseUrl: 'https://a.test', type: 'fake_provider' },
    });
    const config = await loadedConfig(dir);

    await config.resolve(registryWith('fake_provider'));

    expect(Object.keys(config.get('providers')).sort()).toEqual(['backup', 'main']);
  });

  test('makes a single-instance contribution own its own name', async () => {
    const dir = await configDir();
    await write(dir, 'providers.json', {
      only: { baseUrl: 'https://a.test', type: 'solo_provider' },
    });
    const config = await loadedConfig(dir);

    // One rule, two jobs: the name is reserved, and a second instance is
    // impossible because two entries cannot share one key.
    const failure = await config
      .resolve(singletonRegistry('solo_provider'))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('must be named "solo_provider"');
  });

  test('accepts the single instance under the name it owns', async () => {
    const dir = await configDir();
    await write(dir, 'providers.json', {
      solo_provider: { baseUrl: 'https://a.test', type: 'solo_provider' },
    });
    const config = await loadedConfig(dir);

    await config.resolve(singletonRegistry('solo_provider'));

    expect(Object.keys(config.get('providers'))).toEqual(['solo_provider']);
  });
});

describe('entries a section already has because nothing had to be decided', () => {
  /** A contribution whose whole document is determined by its own schema. */
  function defaulted(id: string): ContributionRegistry {
    const registry = new ContributionRegistry();
    const scoped = registry.scoped('test.extension', new DisposableStore());
    scoped.register(
      toolSets,
      id,
      toolSetContribution({
        configSchema: toolSetBaseConfigSchema.extend({ type: z.literal(id) }),
        create: () => ({}) as unknown as ToolSet,
      }),
    );
    return registry;
  }

  test('writes the one entry a fully defaulted singleton could only ever have', async () => {
    const dir = await configDir();
    const config = await loadedConfig(dir);

    await config.resolve(defaulted('solo_tools'));

    // Nothing was configured, and yet nothing had to be: the name is the only
    // one it can have, and the schema determines the rest.
    expect(config.get('toolSets')).toEqual({ solo_tools: { type: 'solo_tools' } });
  });

  test('leaves a singleton that still needs an answer unconfigured', async () => {
    const dir = await configDir();
    const registry = new ContributionRegistry();
    const scoped = registry.scoped('test.extension', new DisposableStore());
    scoped.register(
      toolSets,
      'keyed_tools',
      toolSetContribution({
        configSchema: toolSetBaseConfigSchema.extend({
          endpoint: z.string().min(1),
          type: z.literal('keyed_tools'),
        }),
        create: () => ({}) as unknown as ToolSet,
      }),
    );
    const config = await loadedConfig(dir);

    await config.resolve(registry);

    // Written without its endpoint it would only come back as failed, which is a
    // worse answer than "not configured yet".
    expect(config.get('toolSets')).toEqual({});
  });

  test('never overwrites an entry somebody already wrote', async () => {
    const dir = await configDir();
    await write(dir, 'toolsets.json', {
      solo_tools: { enabledTools: ['kept'], type: 'solo_tools' },
    });
    const config = await loadedConfig(dir);

    await config.resolve(defaulted('solo_tools'));

    expect(config.get('toolSets').solo_tools).toMatchObject({ enabledTools: ['kept'] });
  });

  test('leaves a many-instance contribution alone: no entry is implied', async () => {
    const dir = await configDir();
    const config = await loadedConfig(dir);

    await config.resolve(registryWith('fake_provider'));

    expect(config.get('providers')).toEqual({});
  });
});
