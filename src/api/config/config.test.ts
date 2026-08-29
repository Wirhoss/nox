import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Broker,
  brokerBaseConfigSchema,
  brokerContribution,
  brokers,
  type ChatProvider,
  httpProviderConfigSchema,
  memories,
  type Memory,
  memoryContribution,
  providerContribution,
  providers,
  type RuntimeComponentStatus,
  ToolSet,
  toolSetBaseConfigSchema,
  toolSetContribution,
  toolSets,
} from '@nox/extension-api';
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { AuthorityCatalog } from '../../auth/authority';
import { CORE_AUTHORITIES } from '../../auth/coreAuthorities';
import { Config } from '../../config/config';
import { readEnvConfig } from '../../config/env';
import { SecretStore } from '../../config/secrets';
import { Database } from '../../database/database';
import { ContributionRegistry } from '../../extensions/contribution';
import { DisposableStore } from '../../extensions/disposable';
import { ToolSetCatalog } from '../../extensions/toolSetCatalog';
import { silentLogger } from '../../logger/logger';
import { RegistrationWindow } from '../auth/registration';
import { AuthStore } from '../auth/store';
import { ApiServer } from '../server';
import { ConfigStore } from './store';

import type { ConfigurationRuntime } from '../../runtime/configurationRuntime';

const databases: Database[] = [];
const directories: string[] = [];
const servers: ApiServer[] = [];

const PASSWORD = 'correct-horse-battery';
const TEST_EXTENSION = 'test.extension';

/** A blueprint naming only what the fixture configures. */
const NOX = { model: 'gpt-test', provider: 'main', systemPrompt: 'be exact' };

/** A provider instance of the only kind this fixture registers. */
const PROVIDER = { baseUrl: 'https://main.test', type: 'fake_provider' };

/** Never built here: these routes validate configuration, they do not compose it. */

/**
 * Reads the endpoint past the section's floor.
 *
 * `providers.json` is typed by what every provider has, and an endpoint is not
 * that — it belongs to the ones reached over the network, which is what these
 * entries configure.
 */
function endpointOf(entry: unknown): string | undefined {
  return (entry as undefined | { baseUrl?: string })?.baseUrl;
}

class FakeTools extends ToolSet {
  constructor(config: { enabledTools?: readonly string[] }) {
    super('Fake tools', 'Tools that exist only in this test.', config.enabledTools);
    this.addTools();
  }

  protected override addTools(): void {
    for (const name of ['fake_read', 'fake_write']) {
      this.registerTool({
        authority: `test.extension.${name}`,
        description: `${name} test capability.`,
        name,
        parameters: z.object({}),
        prepare: () => ({
          run: () => Promise.resolve([]),
          title: name,
          type: 'immediate',
        }),
      });
    }
  }
}

/**
 * Provider and tool-set kinds that exist only here. The sections holding them
 * are assembled from the registry, so nothing can configure one before a
 * fixture has contributed it — which is exactly the condition these routes have
 * to answer for.
 */
function registry(): ContributionRegistry {
  const contributions = new ContributionRegistry();
  const scoped = contributions.scoped(TEST_EXTENSION, new DisposableStore());

  scoped.register(
    brokers,
    'fake_broker',
    brokerContribution({
      instances: 'many',
      configSchema: brokerBaseConfigSchema.extend({ type: z.literal('fake_broker') }),
      create: () => ({}) as Broker,
    }),
  );
  scoped.register(
    memories,
    'fake_memory',
    memoryContribution({
      instances: 'many',
      configSchema: z.object({ type: z.literal('fake_memory') }),
      create: () =>
        ({
          recall: () => ({ memories: [] }),
          retain: () => undefined,
        }) satisfies Memory,
    }),
  );
  scoped.register(
    providers,
    'fake_provider',
    providerContribution({
      instances: 'many',
      configSchema: httpProviderConfigSchema.extend({ type: z.literal('fake_provider') }),
      create: () => ({}) as unknown as ChatProvider,
    }),
  );
  scoped.register(
    toolSets,
    'solo_tools',
    toolSetContribution({
      // Required on purpose: a singleton that still needs an answer is the
      // interesting one, and it is never seeded on the operator's behalf.
      configSchema: toolSetBaseConfigSchema.extend({
        endpoint: z.string().min(1),
        type: z.literal('solo_tools'),
      }),
      create: (config) => new FakeTools(config),
    }),
  );
  scoped.register(
    toolSets,
    'fake_tools',
    toolSetContribution({
      instances: 'many',
      configSchema: toolSetBaseConfigSchema.extend({ type: z.literal('fake_tools') }),
      create: (config) => new FakeTools(config),
    }),
  );

  return contributions;
}

interface NoxOptions {
  blueprints?: Record<string, unknown>;
  brokers?: Record<string, unknown>;
  memories?: Record<string, unknown>;
  /** Left unresolved, the contributed sections have no value to administer. */
  resolve?: boolean;
  runtime?: (config: Config) => ConfigurationRuntime;
}

interface ConfigNox {
  readonly config: Config;
  readonly directory: string;
  readonly headers: Record<string, string>;
  readonly url: string;
}

/** Deterministic failing candidate used to exercise API retry/revert semantics. */
class ProviderRuntime implements ConfigurationRuntime {
  readonly #config: Config;

  #generation = 0;
  #statuses: readonly RuntimeComponentStatus[] = [];

  constructor(config: Config) {
    this.#config = config;
  }

  public reconcile(): Promise<void> {
    const generation = ++this.#generation;
    const entry = this.#config.get('providers').main;
    this.#statuses =
      endpointOf(entry) === 'https://broken.test'
        ? [
            {
              activeGeneration: Math.max(1, generation - 1),
              desiredGeneration: generation,
              error: 'candidate refused',
              id: 'main',
              kind: 'provider',
              state: 'failed',
            },
          ]
        : [];
    return Promise.resolve();
  }

  public statuses(): readonly RuntimeComponentStatus[] {
    return this.#statuses;
  }
}

/** A claimed Nox with one account logged in and the config routes mounted. */
async function configNox(options: NoxOptions = {}): Promise<ConfigNox> {
  const directory = await mkdtemp(join(tmpdir(), 'nox-config-'));
  directories.push(directory);

  await mkdir(join(directory, 'blueprints'), { recursive: true });
  for (const [agentId, blueprint] of Object.entries(options.blueprints ?? { nox: NOX })) {
    await writeFile(join(directory, 'blueprints', `${agentId}.json`), JSON.stringify(blueprint));
  }
  await writeFile(join(directory, 'brokers.json'), JSON.stringify(options.brokers ?? {}));
  await writeFile(join(directory, 'memories.json'), JSON.stringify(options.memories ?? {}));
  await writeFile(join(directory, 'providers.json'), JSON.stringify({ main: PROVIDER }));
  await writeFile(
    join(directory, 'toolsets.json'),
    JSON.stringify({ internet: { type: 'fake_tools' } }),
  );

  const config = await Config.load(readEnvConfig({ CONFIG_DIR: directory, NODE_ENV: 'test' }), {
    logger: silentLogger,
  });
  const contributions = registry();
  if (options.resolve !== false) await config.resolve(contributions);

  const database = await Database.open({ logger: silentLogger, path: join(directory, 'nox.db') });
  databases.push(database);
  const secretStore = await SecretStore.open({
    dataDirectory: directory,
    database,
    logger: silentLogger,
  });
  const store = await AuthStore.open({ database, dataDirectory: directory, logger: silentLogger });
  const account = await store.register('esteban', PASSWORD);
  const tokens = await store.openSession(account.accountId);

  const server = ApiServer.create({
    auth: { registration: RegistrationWindow.closed(), store },
    config: new ConfigStore({
      authorities: () => AuthorityCatalog.from([...CORE_AUTHORITIES]),
      config,
      contributions,
      runtime: options.runtime?.(config),
      toolSets: new ToolSetCatalog({
        configured: () => config.get('toolSets'),
        contributions,
        secretStore,
      }),
    }),
    host: '127.0.0.1',
    logger: silentLogger,
    port: 0,
  });
  await server.listen();
  servers.push(server);

  return {
    config,
    directory,
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      'content-type': 'application/json',
    },
    url: `${server.url}/api`,
  };
}

/** What is actually on disk, which is the only copy there is. */
async function onDisk(directory: string, name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(directory, name), 'utf8')) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      // Windows can retain a SQLite handle briefly after close; the OS temp
      // directory is disposable, so cleanup timing is not the assertion here.
      await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    }),
  );
});

describe('reading configuration', () => {
  test('enumerates every section with the shape of write it accepts', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config`, { headers: nox.headers });
    const body = (await response.json()) as {
      sections: { entries: boolean; key: string; loaded: boolean; writable: boolean }[];
    };
    const section = (key: string) => body.sections.find((entry) => entry.key === key);

    expect(response.status).toBe(200);
    expect(body.sections.map((entry) => entry.key)).toEqual([
      'app',
      'blueprints',
      'brokers',
      'memories',
      'providers',
      'toolSets',
    ]);

    // A directory is readable here and administered elsewhere; a contributed
    // section and a directory are both addressed one entry at a time.
    expect(section('blueprints')).toMatchObject({ entries: true, writable: false });
    expect(section('providers')).toMatchObject({ entries: true, loaded: true, writable: true });
    expect(section('app')).toMatchObject({ entries: false, writable: true });
  });

  test('says what a section can hold, not only what it holds', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config`, { headers: nox.headers });
    const body = (await response.json()) as {
      sections: {
        contributions?: {
          configured: boolean;
          extensionId: string;
          instances: string;
          type: string;
        }[];
        key: string;
      }[];
    };
    const memorySection = body.sections.find((entry) => entry.key === 'memories');
    const toolSetSection = body.sections.find((entry) => entry.key === 'toolSets');

    expect(memorySection?.contributions).toEqual([
      { configured: false, extensionId: TEST_EXTENSION, instances: 'many', type: 'fake_memory' },
    ]);

    // An installed extension with no entry is a thing to fill in, not an
    // absence. A surface that only listed entries would show nothing at all
    // after one is installed, which is a wrong answer rather than an empty one.
    expect(toolSetSection?.contributions).toEqual([
      { configured: true, extensionId: TEST_EXTENSION, instances: 'many', type: 'fake_tools' },
      { configured: false, extensionId: TEST_EXTENSION, instances: 'single', type: 'solo_tools' },
    ]);
  });

  test('describes the tools exposed by configured capability instances', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/capabilities/tool-sets`, { headers: nox.headers });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      toolSets: [
        {
          available: true,
          description: 'Tools that exist only in this test.',
          extensionId: 'test.extension',
          id: 'internet',
          name: 'Fake tools',
          tools: [
            {
              authority: 'test.extension.fake_read',
              description: 'fake_read test capability.',
              name: 'fake_read',
            },
            {
              authority: 'test.extension.fake_write',
              description: 'fake_write test capability.',
              name: 'fake_write',
            },
          ],
          type: 'fake_tools',
        },
      ],
    });
  });

  test('describes each configurable tool-set kind with the contribution’s own schema', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/capabilities/tool-set-types`, {
      headers: nox.headers,
    });
    const body = (await response.json()) as {
      toolSetTypes: {
        extensionId: string;
        instances: string;
        schema: Record<string, unknown>;
        type: string;
      }[];
    };

    expect(response.status).toBe(200);
    // Every registered kind, and how many of each a deployment may configure.
    expect(body.toolSetTypes.map(({ instances, type }) => ({ instances, type }))).toEqual([
      { instances: 'many', type: 'fake_tools' },
      { instances: 'single', type: 'solo_tools' },
    ]);
    expect(body.toolSetTypes[0]).toMatchObject({
      extensionId: 'test.extension',
      type: 'fake_tools',
    });
    // The schema an editor builds its form from is the one the loader validates
    // against, down to the discriminator.
    expect(body.toolSetTypes[0]?.schema).toMatchObject({
      properties: { type: { const: 'fake_tools' } },
      type: 'object',
    });
  });

  test('reads one section back with the defaults its schema resolved', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/app`, { headers: nox.headers });
    const body = (await response.json()) as { name: string; value: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.name).toBe('app.json');
    expect(body.value).toMatchObject({ database: { path: 'nox.db' }, logLevel: 'info' });
  });

  test('reads a directory section it will not write', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/blueprints`, { headers: nox.headers });
    const body = (await response.json()) as { value: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(Object.keys(body.value)).toEqual(['nox']);
  });

  test('answers 404 for a section nothing defines', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/nonsense`, { headers: nox.headers });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'section_not_found' });
  });

  test('answers 503 for a section the extensions have not reached yet', async () => {
    const nox = await configNox({ resolve: false });

    const response = await fetch(`${nox.url}/config/providers`, { headers: nox.headers });

    // Not 404: the section exists and has no value, which is a different thing
    // from a section that does not exist, and a different thing to do about it.
    expect(response.status).toBe(503);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: 'section_unresolved',
    });
  });

  test('says nothing at all without a token', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config`);

    expect(response.status).toBe(401);
  });
});

describe('writing a whole section', () => {
  test('applies hot app fields without claiming a restart', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/app`, {
      body: JSON.stringify({ logLevel: 'debug' }),
      headers: nox.headers,
      method: 'PUT',
    });
    const body = (await response.json()) as {
      restartRequired: boolean;
      value: { logLevel: string };
    };

    expect(response.status).toBe(200);
    expect(body.restartRequired).toBeFalse();
    expect(body.value.logLevel).toBe('debug');
    expect(await onDisk(nox.directory, 'app.json')).toMatchObject({ logLevel: 'debug' });
    expect(nox.config.get('app').logLevel).toBe('debug');
  });

  test('keeps infrastructure changes restart-scoped across later hot edits', async () => {
    const nox = await configNox();

    const changed = await fetch(`${nox.url}/config/app`, {
      body: JSON.stringify({ database: { path: 'next.db' }, logLevel: 'debug' }),
      headers: nox.headers,
      method: 'PUT',
    });
    const first = (await changed.json()) as {
      restartRequired: boolean;
      runtime: RuntimeComponentStatus[];
    };

    expect(first.restartRequired).toBeTrue();
    expect(
      first.runtime.some(
        (status) => status.kind === 'application' && status.state === 'restartRequired',
      ),
    ).toBeTrue();

    const hotEdit = await fetch(`${nox.url}/config/app`, {
      body: JSON.stringify({ database: { path: 'next.db' }, logLevel: 'trace' }),
      headers: nox.headers,
      method: 'PUT',
    });
    expect(((await hotEdit.json()) as { restartRequired: boolean }).restartRequired).toBeTrue();
  });

  test('refuses a document its schema rejects, leaving the file alone', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/app`, {
      body: JSON.stringify({ logLevel: 'chatty' }),
      headers: nox.headers,
      method: 'PUT',
    });

    expect(response.status).toBe(422);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_config' });
    expect(await onDisk(nox.directory, 'app.json')).toMatchObject({ logLevel: 'info' });
  });

  test('refuses keys no setting matches rather than dropping them', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/app`, {
      body: JSON.stringify({ logLevel: 'info', logLevelTypo: 'debug' }),
      headers: nox.headers,
      method: 'PUT',
    });

    expect(response.status).toBe(422);
    expect((await response.json()) as { detail: string }).toMatchObject({
      error: 'invalid_config',
    });
  });

  test('refuses to write a directory section whole', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/blueprints`, {
      body: JSON.stringify({ nox: NOX }),
      headers: nox.headers,
      method: 'PUT',
    });

    // The blueprints have their own surface, with the judgement a generic
    // section write has no way to pass.
    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: 'section_not_writable',
    });
  });
});

describe('runtime recovery', () => {
  test('keeps a failed desired entry, then reverts to the last valid document', async () => {
    const nox = await configNox({ runtime: (config) => new ProviderRuntime(config) });

    const failed = await fetch(`${nox.url}/config/providers/main`, {
      body: JSON.stringify({ baseUrl: 'https://broken.test', type: 'fake_provider' }),
      headers: nox.headers,
      method: 'PUT',
    });
    const failedBody = (await failed.json()) as {
      revertAvailable: boolean;
      runtime: RuntimeComponentStatus[];
    };

    expect(failed.status).toBe(200);
    expect(endpointOf(nox.config.get('providers').main)).toBe('https://broken.test');
    expect(failedBody.revertAvailable).toBeTrue();
    expect(
      failedBody.runtime.some(
        (status) => status.id === 'main' && status.kind === 'provider' && status.state === 'failed',
      ),
    ).toBeTrue();

    const reverted = await fetch(`${nox.url}/config/runtime/revert`, {
      body: '{}',
      headers: nox.headers,
      method: 'POST',
    });
    const revertedBody = (await reverted.json()) as { revertAvailable: boolean };

    expect(reverted.status).toBe(200);
    expect(revertedBody.revertAvailable).toBeFalse();
    expect(endpointOf(nox.config.get('providers').main)).toBe('https://main.test');
  });

  test('reloads mounted files independently and retains a valid active document on failure', async () => {
    const nox = await configNox({ runtime: (config) => new ProviderRuntime(config) });
    const providersPath = join(nox.directory, 'providers.json');
    await writeFile(
      providersPath,
      JSON.stringify({ main: { baseUrl: 'https://mounted.test', type: 'fake_provider' } }),
    );

    const loaded = await fetch(`${nox.url}/config/reload`, {
      body: '{}',
      headers: nox.headers,
      method: 'POST',
    });
    expect(loaded.status).toBe(200);
    expect(endpointOf(nox.config.get('providers').main)).toBe('https://mounted.test');

    await writeFile(providersPath, '{ broken');
    const degraded = await fetch(`${nox.url}/config/reload`, {
      body: '{}',
      headers: nox.headers,
      method: 'POST',
    });
    const degradedBody = (await degraded.json()) as {
      runtime: RuntimeComponentStatus[];
      sections: { error?: string; key: string }[];
    };

    expect(degraded.status).toBe(200);
    expect(endpointOf(nox.config.get('providers').main)).toBe('https://mounted.test');
    expect(degradedBody.sections.find((section) => section.key === 'providers')?.error).toContain(
      'valid JSON',
    );
    expect(
      degradedBody.runtime.some(
        (status) =>
          status.id === 'providers' && status.kind === 'provider' && status.state === 'failed',
      ),
    ).toBeTrue();

    await writeFile(
      providersPath,
      JSON.stringify({ main: { baseUrl: 'https://broken.test', type: 'fake_provider' } }),
    );
    const failed = await fetch(`${nox.url}/config/reload`, {
      body: '{}',
      headers: nox.headers,
      method: 'POST',
    });
    expect(((await failed.json()) as { revertAvailable: boolean }).revertAvailable).toBeTrue();

    await fetch(`${nox.url}/config/runtime/revert`, {
      body: '{}',
      headers: nox.headers,
      method: 'POST',
    });
    expect(endpointOf(nox.config.get('providers').main)).toBe('https://mounted.test');
  });
});

describe('writing one entry', () => {
  test('creates one without disturbing the instances already in the file', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/providers/spare`, {
      body: JSON.stringify({ baseUrl: 'https://spare.test', type: 'fake_provider' }),
      headers: nox.headers,
      method: 'POST',
    });
    const body = (await response.json()) as { entryId: string; restartRequired: boolean };

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ entryId: 'spare', restartRequired: false });

    // The whole point of an instance route: one file, and the other instance
    // survived the write untouched.
    expect(await onDisk(nox.directory, 'providers.json')).toMatchObject({
      main: { baseUrl: 'https://main.test' },
      spare: { baseUrl: 'https://spare.test' },
    });
  });

  test('refuses a create that would replace an existing instance', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/providers/main`, {
      body: JSON.stringify(PROVIDER),
      headers: nox.headers,
      method: 'POST',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'entry_exists' });
  });

  test('replaces one whole', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/providers/main`, {
      body: JSON.stringify({ baseUrl: 'https://moved.test', type: 'fake_provider' }),
      headers: nox.headers,
      method: 'PUT',
    });

    expect(response.status).toBe(200);
    expect(await onDisk(nox.directory, 'providers.json')).toMatchObject({
      main: { baseUrl: 'https://moved.test' },
    });
  });

  test('refuses a replace of an instance nothing configures', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/providers/ghost`, {
      body: JSON.stringify(PROVIDER),
      headers: nox.headers,
      method: 'PUT',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'entry_not_found' });
  });

  test('refuses to change the schema of an existing tool set', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/toolSets/internet`, {
      body: JSON.stringify({ type: 'some_other_tools' }),
      headers: nox.headers,
      method: 'PUT',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'contribution_type_change' });
    expect(await onDisk(nox.directory, 'toolsets.json')).toEqual({
      internet: { type: 'fake_tools' },
    });
  });

  test('refuses to change the contributed schema of an existing provider', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/providers/main`, {
      body: JSON.stringify({ baseUrl: 'https://main.test', type: 'some_other_provider' }),
      headers: nox.headers,
      method: 'PUT',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'contribution_type_change' });
    expect(await onDisk(nox.directory, 'providers.json')).toMatchObject({
      main: { type: 'fake_provider' },
    });
  });

  test('refuses to change the contributed schema of an existing broker', async () => {
    const nox = await configNox({
      brokers: { relay: { agent: 'nox', type: 'fake_broker' } },
    });

    const response = await fetch(`${nox.url}/config/brokers/relay`, {
      body: JSON.stringify({ agent: 'nox', type: 'some_other_broker' }),
      headers: nox.headers,
      method: 'PUT',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'contribution_type_change' });
    expect(await onDisk(nox.directory, 'brokers.json')).toMatchObject({
      relay: { agent: 'nox', type: 'fake_broker' },
    });
  });

  test('also protects broker schema identity during whole-document writes', async () => {
    const nox = await configNox({
      brokers: { relay: { agent: 'nox', type: 'fake_broker' } },
    });

    const response = await fetch(`${nox.url}/config/brokers`, {
      body: JSON.stringify({ relay: { agent: 'nox', type: 'some_other_broker' } }),
      headers: nox.headers,
      method: 'PUT',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'contribution_type_change' });
    expect(await onDisk(nox.directory, 'brokers.json')).toMatchObject({
      relay: { agent: 'nox', type: 'fake_broker' },
    });
  });

  test('refuses an instance whose kind no extension registered', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/providers/spare`, {
      body: JSON.stringify({ baseUrl: 'https://spare.test', type: 'no_such_kind' }),
      headers: nox.headers,
      method: 'POST',
    });

    expect(response.status).toBe(422);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_config' });
    expect(Object.keys(await onDisk(nox.directory, 'providers.json'))).toEqual(['main']);
  });

  test('refuses broker routes and grants that gateway composition cannot resolve', async () => {
    const nox = await configNox();

    const unknownAgent = await fetch(`${nox.url}/config/brokers/discord`, {
      body: JSON.stringify({ agent: 'ghost', type: 'fake_broker' }),
      headers: nox.headers,
      method: 'POST',
    });
    expect(unknownAgent.status).toBe(422);
    expect((await unknownAgent.json()) as { problems: string[] }).toMatchObject({
      problems: ['blueprints configures no base agent "ghost"'],
    });

    const unknownAuthority = await fetch(`${nox.url}/config/brokers/discord`, {
      body: JSON.stringify({
        agent: 'nox',
        grants: { esteban: ['nox.unknown'] },
        type: 'fake_broker',
      }),
      headers: nox.headers,
      method: 'POST',
    });
    expect(unknownAuthority.status).toBe(422);
    expect((await unknownAuthority.json()) as { problems: string[] }).toMatchObject({
      problems: [expect.stringContaining('nox.unknown')],
    });
    expect(await onDisk(nox.directory, 'brokers.json')).toEqual({});
  });

  test('accepts unresolved dormant routes on a disabled broker', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/brokers/discord`, {
      body: JSON.stringify({ agent: 'ghost', enabled: false, type: 'fake_broker' }),
      headers: nox.headers,
      method: 'POST',
    });

    expect(response.status).toBe(201);
    expect(await onDisk(nox.directory, 'brokers.json')).toMatchObject({
      discord: { agent: 'ghost', enabled: false },
    });
  });

  test('has no instances to address in a section holding one document', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/app/logLevel`, {
      body: JSON.stringify({ value: 'debug' }),
      headers: nox.headers,
      method: 'PUT',
    });

    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: 'section_has_no_entries',
    });
  });
});

describe('removing one entry', () => {
  test('removes one nothing names', async () => {
    const nox = await configNox();
    await fetch(`${nox.url}/config/toolSets/spare`, {
      body: JSON.stringify({ type: 'fake_tools' }),
      headers: nox.headers,
      method: 'POST',
    });

    const response = await fetch(`${nox.url}/config/toolSets/spare`, {
      headers: nox.headers,
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect(Object.keys(await onDisk(nox.directory, 'toolsets.json'))).toEqual(['internet']);
  });

  test('refuses to remove a memory a blueprint still names', async () => {
    const nox = await configNox({
      blueprints: { nox: { ...NOX, memory: { id: 'long-term' } } },
      memories: { 'long-term': { type: 'fake_memory' } },
    });

    const response = await fetch(`${nox.url}/config/memories/long-term`, {
      headers: nox.headers,
      method: 'DELETE',
    });
    const body = (await response.json()) as { error: string; reasons: string[] };

    expect(response.status).toBe(409);
    expect(body.error).toBe('entry_in_use');
    expect(body.reasons).toEqual(['blueprints/nox.json names it.']);
    expect(Object.keys(await onDisk(nox.directory, 'memories.json'))).toEqual(['long-term']);
  });

  test('refuses to remove a provider a blueprint still names', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/providers/main`, {
      headers: nox.headers,
      method: 'DELETE',
    });
    const body = (await response.json()) as { error: string; reasons: string[] };

    // Bootstrap fails on a blueprint naming a provider nothing configures. The
    // operator finds out here, not at a restart days later.
    expect(response.status).toBe(409);
    expect(body.error).toBe('entry_in_use');
    expect(body.reasons).toEqual(['blueprints/nox.json names it.']);
    expect(Object.keys(await onDisk(nox.directory, 'providers.json'))).toEqual(['main']);
  });

  test('refuses to remove a tool set a blueprint still grants', async () => {
    const nox = await configNox({
      blueprints: { nox: { ...NOX, toolSets: { direct: [{ id: 'internet', tools: ['fetch'] }] } } },
    });

    const response = await fetch(`${nox.url}/config/toolSets/internet`, {
      headers: nox.headers,
      method: 'DELETE',
    });
    const body = (await response.json()) as { reasons: string[] };

    // Named through the object form of a grant, which is the form a reference
    // check reading only strings would have missed.
    expect(response.status).toBe(409);
    expect(body.reasons).toEqual(['blueprints/nox.json names it.']);
  });

  test('refuses to remove an agent an enabled broker still routes to', async () => {
    const nox = await configNox({
      blueprints: {
        nox: NOX,
        spare: { ...NOX, systemPrompt: 'be spare' },
      },
      brokers: {
        discord: { agent: 'nox', type: 'fake_broker' },
      },
    });

    const response = await fetch(`${nox.url}/config/blueprints/nox`, {
      headers: nox.headers,
      method: 'DELETE',
    });
    const body = (await response.json()) as { reasons: string[] };

    expect(response.status).toBe(409);
    expect(body.reasons).toEqual(['brokers.json entry "discord" names it as its base agent.']);
  });

  test('answers 404 for an instance nothing configures', async () => {
    const nox = await configNox();

    const response = await fetch(`${nox.url}/config/providers/ghost`, {
      headers: nox.headers,
      method: 'DELETE',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'entry_not_found' });
  });
});
