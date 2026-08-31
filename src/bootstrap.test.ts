import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  commands,
  isChatCapable,
  isEmbeddingCapable,
  memories,
  providers,
  toolSets,
} from '@nox/extension-api';
import { Database as SqliteConnection } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';

import { AuthStore } from './api/auth/store';
import { ApiServer } from './api/server';
import { ArtifactStorageQuotaError } from './artifact/error';
import { bootstrap } from './bootstrap';
import { SecretStore } from './config/secrets';
import { Database } from './database/database';
import { silentLogger } from './logger/logger';
import {
  artifactPipelineService,
  configAdminService,
  configService,
  loggerService,
  secretStoreService,
} from './services';

import type { NoxApplication } from './application';
import type { EnvSource } from './config/env';

const directories: string[] = [];
const PASSWORD = 'correct-horse-battery';
let booted: NoxApplication | undefined;

/** What a working installation looks like: one blueprint, one provider. */
const NOX = { model: 'gpt-test', provider: 'main', systemPrompt: 'be exact' };
const PROVIDERS = {
  main: {
    apiKey: { $secret: 'OPENAI_API_KEY' },
    baseUrl: 'https://api.example.test/v1',
    defaultModel: 'gpt-test',
    type: 'openai_completions',
  },
};

afterEach(async () => {
  await booted?.stop();
  booted = undefined;
  for (const directory of directories.splice(0)) {
    // Windows keeps the SQLite file handle briefly after close(); the temp
    // directory is disposable either way, so a failed unlink is not a failure.
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      /* empty */
    }
  }
});

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

interface BootOptions {
  app?: unknown;
  blueprints?: Record<string, unknown>;
  brokers?: unknown;
  configWatch?: boolean;
  dataDir?: string;
  extensionsDir?: string;
  memories?: unknown;
  providers?: unknown;
  secrets?: Readonly<Record<string, string>>;
  toolSets?: unknown;
}

async function seed(options: BootOptions = {}): Promise<EnvSource> {
  const configDir = temporary('nox-config-');
  const dataDir = options.dataDir ?? temporary('nox-data-');
  // Port 0 unless a test says otherwise: every boot listens, and no two boots
  // — or a Nox already running on this machine — fight over the same socket.
  writeFileSync(join(configDir, 'app.json'), JSON.stringify(options.app ?? { api: { port: 0 } }));
  writeFileSync(join(configDir, 'memories.json'), JSON.stringify(options.memories ?? {}));
  writeFileSync(join(configDir, 'providers.json'), JSON.stringify(options.providers ?? PROVIDERS));
  writeFileSync(join(configDir, 'brokers.json'), JSON.stringify(options.brokers ?? {}));
  writeFileSync(join(configDir, 'toolsets.json'), JSON.stringify(options.toolSets ?? {}));

  mkdirSync(join(configDir, 'blueprints'), { recursive: true });
  for (const [name, blueprint] of Object.entries(options.blueprints ?? { nox: NOX })) {
    writeFileSync(join(configDir, 'blueprints', `${name}.json`), JSON.stringify(blueprint));
  }

  const database = await Database.open({ path: join(dataDir, 'nox.db') });
  try {
    const store = await SecretStore.open({ dataDirectory: dataDir, database });
    for (const [secretId, value] of Object.entries(
      options.secrets ?? { OPENAI_API_KEY: 'sk-test' },
    )) {
      await store.set(secretId, value);
    }
    const auth = await AuthStore.open({ database, dataDirectory: dataDir });
    await auth.register('esteban', PASSWORD);
  } finally {
    await database.close();
  }

  return {
    CONFIG_DIR: configDir,
    ...(options.configWatch === true
      ? { CONFIG_WATCH: 'true', CONFIG_WATCH_DEBOUNCE_MS: '50' }
      : {}),
    DATA_DIR: dataDir,
    ...(options.extensionsDir === undefined ? {} : { EXTENSIONS_DIR: options.extensionsDir }),
    NODE_ENV: 'test',
  };
}

async function boot(options: BootOptions = {}): Promise<NoxApplication> {
  booted = await bootstrap({ env: await seed(options), logger: silentLogger });
  return booted;
}

async function login(url: string): Promise<Record<string, string>> {
  const response = await fetch(`${url}/api/auth/login`, {
    body: JSON.stringify({ password: PASSWORD, username: 'esteban' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  const body = (await response.json()) as { accessToken: string };
  return {
    authorization: `Bearer ${body.accessToken}`,
    'content-type': 'application/json',
  };
}

describe('bootstrap', () => {
  test('wires an agent from a provider nothing in the kernel imported', async () => {
    const application = await boot();

    expect(application.state).toBe('running');
    expect(application.contributions.get(providers, 'openai_completions')?.extensionId).toBe(
      'nox.provider.openai',
    );
    expect(application.agentIds).toEqual(['nox']);
    expect(application.getAgent('nox')?.model).toEqual({
      inputModalities: ['text'],
      kind: 'chat',
      modelId: 'gpt-test',
      outputModalities: ['text'],
    });
    expect(application.getAgent('nox')?.systemPrompt).toBe('be exact');
  });

  test('composes the memory an agent selected as a builtin contribution', async () => {
    const application = await boot({
      blueprints: { nox: { ...NOX, memory: { id: 'semantic', maxTokens: 512 } } },
      extensionsDir: join(import.meta.dir, 'runtime', 'fixtures'),
      memories: {
        semantic: {
          embedding: { model: 'counting', provider: 'counting_test' },
          extraction: { model: 'gpt-test', provider: 'main' },
          type: 'semantic',
        },
      },
      providers: {
        ...PROVIDERS,
        counting_test: {
          modelConfigs: [{ dimensions: 4, kind: 'embedding', modelId: 'counting' }],
          type: 'counting_test',
        },
      },
    });

    expect(application.contributions.get(memories, 'semantic')?.extensionId).toBe(
      'nox.memory.semantic',
    );
    expect(application.services.get(configService).get('memories')).toHaveProperty('semantic');
    expect(
      application.services
        .get(configAdminService)
        .runtimeStatuses()
        .find(({ id, kind }) => id === 'semantic' && kind === 'memory'),
    ).toMatchObject({ id: 'semantic', kind: 'memory', state: 'active' });
    expect(application.getAgent('nox')).toBeDefined();
  });

  test('registers Sharp as the first concrete artifact processor', async () => {
    const application = await boot();
    const artifacts = application.services.get(artifactPipelineService);
    const stored = await artifacts.ingest({
      data: new Blob([
        '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"><rect width="4" height="2"/></svg>',
      ]),
      declaredMediaType: 'image/svg+xml',
      provenance: { type: 'upload' },
      scope: { id: 'bootstrap-test', type: 'system' },
    });

    const imageProfile = {
      id: 'test.bootstrap.image',
      mediaTypes: ['image/png'],
      version: 1,
    } as const;
    const resolved = await artifacts.resolve(stored.artifactId, imageProfile);
    const bytes = new Uint8Array(await new Response(resolved.stream).arrayBuffer());

    expect(resolved.representation.type).toBe('rendition');
    if (resolved.representation.type !== 'rendition') throw new Error('Expected a rendition.');
    expect(resolved.representation.processor.id).toBe('nox.image.sharp');
    expect(resolved.representation.mediaType).toBe('image/png');
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    await application.stop();
    booted = undefined;
    expect(
      artifacts.processors.select(
        { blobHash: stored.blobHash, mediaType: stored.mediaType, size: stored.size },
        imageProfile,
      ),
    ).toBeUndefined();
  });

  test('wires a contributed tool-set instance into a blueprint', async () => {
    const application = await boot({
      blueprints: {
        nox: { ...NOX, toolSets: { direct: ['web'], routed: [] } },
      },
      secrets: { OPENAI_API_KEY: 'sk-test', SEARXNG_API_KEY: 'search-secret' },
      toolSets: {
        web: {
          search: {
            apiKey: { $secret: 'SEARXNG_API_KEY' },
            module: 'searxng',
            url: 'https://search.example.test',
          },
          type: 'web',
        },
      },
    });

    expect(application.contributions.get(toolSets, 'web')?.extensionId).toBe('nox.toolset.web');
    expect(application.services.get(configService).get('toolSets')).toHaveProperty('web');
    expect(application.services.get(secretStoreService).consumers('SEARXNG_API_KEY')).toEqual([
      { extensionId: 'nox.toolset.web', location: 'toolSets.web.search.apiKey' },
    ]);

    const session = await application.openSession('nox');
    await application.closeSession(session.sessionId);
  });

  test('composes the configuration tool set against the shared administration service', async () => {
    const application = await boot({
      blueprints: {
        nox: { ...NOX, toolSets: { direct: ['config'], routed: [] } },
      },
      toolSets: {
        config: {
          manageRuntime: false,
          readSecretMetadata: false,
          readSections: ['blueprints', 'providers'],
          type: 'config',
          writeSections: [],
        },
      },
    });

    expect(application.contributions.get(toolSets, 'config')?.extensionId).toBe(
      'nox.toolset.config',
    );
    const configAdmin = application.services.get(configAdminService);
    expect(configAdmin.sections().map(({ key }) => key)).toEqual([
      'app',
      'blueprints',
      'brokers',
      'memories',
      'providers',
      'toolSets',
    ]);
    expect(
      configAdmin
        .schema('toolSets')
        .types?.some(
          ({ extensionId, type }) => extensionId === 'nox.toolset.config' && type === 'config',
        ),
    ).toBe(true);

    const session = await application.openSession('nox');
    await application.closeSession(session.sessionId);
  });

  test('carries a blueprint allowlist through to the tools a session opens with', async () => {
    const web = {
      extract: { module: 'crawl4ai', url: 'https://crawl.example.test' },
      search: { module: 'searxng', url: 'https://search.example.test' },
      type: 'web',
    };

    // Two agents over one configured instance, which is the case the allowlist
    // exists for: the instance is shared, so the cut cannot live on it.
    const application = await boot({
      app: { api: { port: 0 } },
      blueprints: {
        nox: { ...NOX, toolSets: { direct: [{ id: 'web', tools: ['web_search'] }] } },
        typo: { ...NOX, toolSets: { direct: [{ id: 'web', tools: ['web_crawl'] }] } },
      },
      toolSets: { web },
    });

    const session = await application.openSession('nox');
    await application.closeSession(session.sessionId);

    // A name the instance does not expose fails where the set and the name are
    // both in hand, rather than granting nothing in silence. Candidate agents
    // compose before registration, so no first session can discover the typo.
    expect(application.getAgent('typo')).toBeUndefined();
    expect(
      application.services
        .get(configAdminService)
        .runtimeStatuses()
        .find(({ id, kind }) => id === 'typo' && kind === 'agent')?.error,
    ).toContain('does not expose tool web_crawl');
  });

  test('registers one agent per file in the blueprints directory', async () => {
    const application = await boot({
      app: { api: { port: 0 } },
      blueprints: {
        mailroom: { ...NOX, systemPrompt: 'read the mail' },
        nox: NOX,
        watcher: { ...NOX, systemPrompt: 'watch' },
      },
    });

    // The file name is the agent ID: what a transcript is filed under is the
    // name on disk, so the two cannot drift.
    expect(application.agentIds).toEqual(['mailroom', 'nox', 'watcher']);
    expect(application.getAgent('watcher')?.systemPrompt).toBe('watch');
  });

  test('takes the model budget from the provider entry that declared it', async () => {
    const application = await boot({
      providers: {
        main: {
          ...PROVIDERS.main,
          modelConfigs: [{ contextWindow: 4096, modelId: 'gpt-test' }],
        },
      },
    });

    // Law 2 needs a budget to fold before it compacts, and a model's budget is a
    // property of the model, so it is configured beside it.
    expect(application.getAgent('nox')?.model).toMatchObject({ contextWindow: 4096 });
  });

  test('keeps agent generation policy separate from provider model facts', async () => {
    const application = await boot({
      blueprints: {
        nox: { ...NOX, generation: { maxTokens: 1200, temperature: 0.2 } },
      },
      providers: {
        main: {
          ...PROVIDERS.main,
          modelConfigs: [{ contextWindow: 4096, modelId: 'gpt-test' }],
        },
      },
    });

    expect(application.getAgent('nox')?.model).toEqual({
      contextWindow: 4096,
      inputModalities: ['text'],
      kind: 'chat',
      modelId: 'gpt-test',
      outputModalities: ['text'],
    });
  });

  test('configures more than one instance of the same provider kind', async () => {
    const application = await boot({
      blueprints: { nox: { ...NOX, provider: 'secondary' } },
      providers: {
        main: PROVIDERS.main,
        secondary: { ...PROVIDERS.main, baseUrl: 'https://other.example.test/v1' },
      },
    });

    // The contribution is the kind; the key in providers.json is the instance.
    // Collapsing the two would make a second endpoint impossible to configure.
    expect(application.services.get(configService).get('providers')).toHaveProperty('secondary');
    expect(application.state).toBe('running');
  });

  test('hands the host services to the application rather than keeping them', async () => {
    const application = await boot();

    expect(application.services.get(configService).get('app').logLevel).toBeString();
    expect(application.services.get(artifactPipelineService).directory).toContain('artifacts');
    const provider: unknown = application.services.get(configService).get('providers').main;
    expect((provider as { apiKey?: unknown }).apiKey).toMatchObject({
      $secret: 'OPENAI_API_KEY',
    });
    expect(application.services.get(loggerService)).toBe(silentLogger);
    expect(application.services.get(secretStoreService).consumers('OPENAI_API_KEY')).toEqual([
      { extensionId: 'nox.provider.openai', location: 'providers.main.apiKey' },
    ]);
  });

  test('wires configured artifact limits into the storage pipeline', async () => {
    const application = await boot({
      app: {
        api: { port: 0 },
        artifacts: { maxArtifactBytes: 4, maxStorageBytes: 4 },
      },
    });
    const artifacts = application.services.get(artifactPipelineService);
    await artifacts.ingest({
      data: new Blob(['1234']),
      declaredMediaType: 'text/plain',
      provenance: { type: 'upload' },
      scope: { id: 'account-1', type: 'account' },
    });

    expect(
      artifacts.ingest({
        data: new Blob(['abcd']),
        declaredMediaType: 'text/plain',
        provenance: { type: 'upload' },
        scope: { id: 'account-1', type: 'account' },
      }),
    ).rejects.toBeInstanceOf(ArtifactStorageQuotaError);
  });

  test('opens storage under the configured data directory', async () => {
    const dataDir = temporary('nox-data-');
    await boot({ dataDir });

    expect(existsSync(join(dataDir, 'nox.db'))).toBe(true);
  });

  test('opens a session that persists and resumes by id', async () => {
    const application = await boot();

    const session = await application.openSession('nox', { sessionId: 'first-run' });
    expect(session.sessionId).toBe('first-run');
    await application.closeSession('first-run');

    const resumed = await application.openSession('nox', { sessionId: 'first-run' });
    expect(resumed.sessionId).toBe('first-run');
    await application.closeSession('first-run');
  });

  test('stop releases sessions, extensions and storage, and is idempotent', async () => {
    const application = await boot();
    await application.openSession('nox');

    await application.stop();
    await application.stop();

    expect(application.state).toBe('stopped');
    expect(application.sessions).toEqual([]);
    expect(application.contributions.has(providers, 'openai_completions')).toBe(false);
    expect(application.contributions.has(toolSets, 'web')).toBe(false);
  });

  test('answers the health probes over HTTP, and stops answering once stopped', async () => {
    const api = { host: '127.0.0.1', port: 39_517 };
    const application = await boot({ app: { api } });
    const url = `http://${api.host}:${String(api.port)}`;

    const live = await fetch(`${url}/api/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ status: 'pass' });

    const ready = await fetch(`${url}/api/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      checks: { database: 'pass', nox: 'pass' },
      status: 'pass',
    });

    const headers = await login(url);
    const extensionResponse = await fetch(`${url}/api/extensions`, { headers });
    expect(extensionResponse.status).toBe(200);
    const extensionInventory = (await extensionResponse.json()) as {
      extensionApiVersion: string;
      extensions: {
        contributions: { id: string; point: string }[];
        id: string;
        origin: string;
        state: string;
      }[];
    };
    expect(extensionInventory.extensionApiVersion).toBe('0.1.0');
    const configExtension = extensionInventory.extensions.find(
      ({ id }) => id === 'nox.toolset.config',
    );
    expect(configExtension).toMatchObject({ origin: 'builtin', state: 'active' });
    expect(configExtension?.contributions).toContainEqual({ id: 'config', point: 'nox.toolsets' });

    await application.stop();

    // The listener goes with everything else: another server can take the port.
    const rebound = ApiServer.create(api);
    await rebound.listen();
    await rebound.dispose();
  });

  test('publishes session commands contributed by the builtin extension', async () => {
    const api = { host: '127.0.0.1', port: 39_522 };
    const application = await boot({ app: { api }, brokers: { web: { type: 'web' } } });
    const url = `http://${api.host}:${String(api.port)}`;
    const headers = await login(url);

    expect(
      application.contributions
        .list(commands)
        .filter(({ extensionId }) => extensionId === 'nox.commands.session')
        .map(({ id }) => id)
        .sort(),
    ).toEqual([
      'agent',
      'commands',
      'compact',
      'help',
      'model',
      'new',
      'rename',
      'retry',
      'session',
      'tools',
    ]);

    const response = await fetch(`${url}/api/chat/commands`, { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { commands: { name: string }[] };
    expect(body.commands.map(({ name }) => name)).toEqual([
      'agent',
      'commands',
      'compact',
      'help',
      'model',
      'new',
      'rename',
      'retry',
      'session',
      'stop',
      'tools',
    ]);
  });

  test('always gives the built-in web transport its chat surface', async () => {
    const api = { host: '127.0.0.1', port: 39_519 };
    const application = await boot({ app: { api }, brokers: {} });
    const url = `http://${api.host}:${String(api.port)}`;

    expect(application.state).toBe('running');

    // Mounted rather than missing: an unauthenticated caller is turned away by
    // the guard, which is a route answering. A surface that had never been
    // composed would not know the path at all.
    const stream = await fetch(`${url}/api/chat/stream`);
    expect(stream.status).toBe(401);
  });

  test('starts with multiple agents and lets Web ask which one to use', async () => {
    const application = await boot({
      app: { api: { port: 0 } },
      blueprints: {
        mailroom: { ...NOX, systemPrompt: 'read the mail' },
        watcher: { ...NOX, systemPrompt: 'watch' },
      },
    });

    expect(application.state).toBe('running');
    expect(application.agentIds).toEqual(['mailroom', 'watcher']);
  });

  test('drops Web’s implicit default when a second agent hot-activates', async () => {
    const api = { host: '127.0.0.1', port: 39_520 };
    const application = await boot({ app: { api }, brokers: { web: { type: 'web' } } });
    const url = `http://${api.host}:${String(api.port)}`;
    const headers = await login(url);

    const before = (await (await fetch(`${url}/api/chat/agents`, { headers })).json()) as {
      agents: string[];
      defaultAgent?: string;
    };
    expect(before).toEqual({ agents: ['nox'], defaultAgent: 'nox' });

    const created = await fetch(`${url}/api/config/blueprints/support`, {
      body: JSON.stringify({ ...NOX, systemPrompt: 'support' }),
      headers,
      method: 'POST',
    });
    expect(created.status).toBe(201);
    expect(application.agentIds).toEqual(['nox', 'support']);

    const after = (await (await fetch(`${url}/api/chat/agents`, { headers })).json()) as {
      agents: string[];
      defaultAgent?: string;
    };
    expect(after).toEqual({ agents: ['nox', 'support'] });

    const removedSupport = await fetch(`${url}/api/config/blueprints/support`, {
      headers,
      method: 'DELETE',
    });
    expect(removedSupport.status).toBe(200);
    expect(
      (await (await fetch(`${url}/api/chat/agents`, { headers })).json()) as {
        agents: string[];
        defaultAgent?: string;
      },
    ).toEqual({ agents: ['nox'], defaultAgent: 'nox' });

    const removedLast = await fetch(`${url}/api/config/blueprints/nox`, {
      headers,
      method: 'DELETE',
    });
    expect(removedLast.status).toBe(200);
    expect(application.agentIds).toEqual([]);
    expect(
      (await (await fetch(`${url}/api/chat/agents`, { headers })).json()) as {
        agents: string[];
        defaultAgent?: string;
      },
    ).toEqual({ agents: [] });
  });

  test('hot-applies blueprints, timezone, logging and the installation locale', async () => {
    const api = { host: '127.0.0.1', port: 39_515 };
    const application = await boot({ app: { api } });
    const url = `http://${api.host}:${String(api.port)}`;
    const headers = await login(url);
    const firstAgent = application.getAgent('nox');

    const blueprint = await fetch(`${url}/api/config/blueprints/nox`, {
      body: JSON.stringify({ ...NOX, systemPrompt: 'changed now' }),
      headers,
      method: 'PUT',
    });
    expect(blueprint.status).toBe(200);
    expect(((await blueprint.json()) as { restartRequired: boolean }).restartRequired).toBeFalse();
    expect(application.getAgent('nox')?.systemPrompt).toBe('changed now');
    expect(application.getAgent('nox')).not.toBe(firstAgent);

    const app = await fetch(`${url}/api/config/app`, {
      body: JSON.stringify({
        api,
        logLevel: 'error',
        timezone: 'America/Mexico_City',
        ui: { locale: 'es' },
      }),
      headers,
      method: 'PUT',
    });
    expect(app.status).toBe(200);
    expect(((await app.json()) as { restartRequired: boolean }).restartRequired).toBeFalse();
    expect(application.getAgent('nox')).not.toBe(firstAgent);

    const beforeSecretRotation = application.getAgent('nox');
    await application.services.get(secretStoreService).set('OPENAI_API_KEY', 'sk-rotated');
    expect(application.getAgent('nox')).not.toBe(beforeSecretRotation);

    const languages = await fetch(`${url}/api/i18n/languages`);
    expect((await languages.json()) as { configuredLocale?: string }).toMatchObject({
      configuredLocale: 'es',
    });
  });

  test('optionally reloads mounted configuration after a debounce', async () => {
    const env = await seed({ configWatch: true });
    const configDir = env.CONFIG_DIR;
    if (configDir === undefined) throw new Error('Expected a config directory.');
    booted = await bootstrap({ env, logger: silentLogger });

    writeFileSync(
      join(configDir, 'blueprints', 'nox.json'),
      JSON.stringify({ ...NOX, systemPrompt: 'watched change' }),
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (booted.getAgent('nox')?.systemPrompt === 'watched change') break;
      await Bun.sleep(10);
    }

    expect(booted.getAgent('nox')?.systemPrompt).toBe('watched change');
  });

  test('hot-disables and restores the Web broker', async () => {
    const api = { host: '127.0.0.1', port: 39_516 };
    await boot({ app: { api }, brokers: { web: { type: 'web' } } });
    const url = `http://${api.host}:${String(api.port)}`;
    const headers = await login(url);

    const disabled = await fetch(`${url}/api/config/brokers/web`, {
      body: JSON.stringify({ enabled: false, type: 'web' }),
      headers,
      method: 'PUT',
    });
    expect(disabled.status).toBe(200);
    expect(((await disabled.json()) as { restartRequired: boolean }).restartRequired).toBeFalse();
    expect((await fetch(`${url}/api/chat/agents`, { headers })).status).toBe(503);

    const enabled = await fetch(`${url}/api/config/brokers/web`, {
      body: JSON.stringify({ type: 'web' }),
      headers,
      method: 'PUT',
    });
    expect(enabled.status).toBe(200);
    expect((await fetch(`${url}/api/chat/agents`, { headers })).status).toBe(200);
  });

  test('keeps the repair API listening when agent composition fails', async () => {
    const api = { host: '127.0.0.1', port: 39_518 };
    const degraded = await boot({
      app: { api },
      blueprints: { nox: { ...NOX, provider: 'missing' } },
    });

    expect(degraded.state).toBe('running');
    expect(degraded.agentIds).toEqual([]);
    expect((await fetch(`http://${api.host}:${String(api.port)}/api/health/live`)).status).toBe(
      200,
    );

    await degraded.stop();
    booted = undefined;
    const repaired = await boot({ app: { api } });
    expect(repaired.state).toBe('running');
  });

  test('retains a routed agent when a mounted blueprint removal cannot activate', async () => {
    const api = { host: '127.0.0.1', port: 39_521 };
    const env = await seed({
      app: { api },
      brokers: { web: { agent: 'nox', type: 'web' } },
    });
    const configDir = env.CONFIG_DIR;
    if (configDir === undefined) throw new Error('Expected a config directory.');
    booted = await bootstrap({ env, logger: silentLogger });
    const url = `http://${api.host}:${String(api.port)}`;
    const headers = await login(url);

    rmSync(join(configDir, 'blueprints', 'nox.json'));
    const reloaded = await fetch(`${url}/api/config/reload`, {
      body: '{}',
      headers,
      method: 'POST',
    });
    const degraded = (await reloaded.json()) as {
      revertAvailable: boolean;
      runtime: { error?: string; id: string; kind: string; state: string }[];
    };

    expect(booted.getAgent('nox')).toBeDefined();
    expect(degraded.revertAvailable).toBeTrue();
    expect(
      degraded.runtime.some(
        (status) =>
          status.id === 'nox' &&
          status.kind === 'agent' &&
          status.state === 'failed' &&
          typeof status.error === 'string' &&
          status.error.includes('still routes'),
      ),
    ).toBeTrue();

    const reverted = await fetch(`${url}/api/config/runtime/revert`, {
      body: '{}',
      headers,
      method: 'POST',
    });
    expect(reverted.status).toBe(200);
    expect(booted.getAgent('nox')).toBeDefined();
  });

  test('keeps the control plane running with no blueprint configured', async () => {
    const application = await boot({ blueprints: {} });

    expect(application.state).toBe('running');
    expect(application.agentIds).toEqual([]);
  });

  test('keeps running when a blueprint names an unconfigured provider', async () => {
    const application = await boot({ blueprints: { nox: { ...NOX, provider: 'missing' } } });

    expect(application.state).toBe('running');
    expect(application.agentIds).toEqual([]);
  });

  test('keeps running when a blueprint names an unconfigured tool set', async () => {
    const application = await boot({
      blueprints: {
        nox: { ...NOX, toolSets: { direct: ['missing'], routed: [] } },
      },
    });

    expect(application.state).toBe('running');
    expect(application.agentIds).toEqual([]);
  });

  test('isolates a tool-set kind nobody contributed', async () => {
    const application = await boot({ toolSets: { internet: { type: 'ghost' } } });
    const config = application.services.get(configService);

    expect(application.state).toBe('running');
    expect(config.problems.find((problem) => problem.key === 'toolSets')?.error).toContain(
      'toolsets.json',
    );
  });

  test('isolates a blueprint missing what its schema requires', async () => {
    const application = await boot({ blueprints: { nox: { provider: 'main' } } });
    const config = application.services.get(configService);

    expect(application.state).toBe('running');
    expect(config.problems.find((problem) => problem.key === 'blueprints')?.error).toContain(
      'model',
    );
  });

  test('isolates a provider kind nobody contributed', async () => {
    const application = await boot({
      providers: { main: { baseUrl: 'https://api.example.test/v1', type: 'anthropic' } },
    });
    const config = application.services.get(configService);

    expect(application.state).toBe('running');
    expect(config.problems.find((problem) => problem.key === 'providers')?.error).toContain(
      'openai_completions',
    );
  });

  test('isolates a provider entry missing what its schema requires', async () => {
    const application = await boot({ providers: { main: { type: 'openai_completions' } } });
    const config = application.services.get(configService);

    expect(application.state).toBe('running');
    expect(config.problems.find((problem) => problem.key === 'providers')?.error).toContain(
      'baseUrl',
    );
  });

  test('isolates a plaintext credential in ordinary configuration', async () => {
    const application = await boot({
      providers: { main: { ...PROVIDERS.main, apiKey: 'plaintext' } },
    });
    const config = application.services.get(configService);
    const problem = config.problems.find((candidate) => candidate.key === 'providers')?.error;

    expect(application.state).toBe('running');
    expect(problem).toContain('apiKey');
    expect(problem).toContain('$secret');
  });

  test('boots when configuration names a credential nobody has stored yet', async () => {
    // `apiKey` is optional, so an empty store is an ordinary state the secrets
    // surface shows as an unfilled row rather than a failure only a boot reports.
    const application = await boot({ secrets: {} });

    expect(application.getAgent('nox')).toBeDefined();
    expect(application.services.get(secretStoreService).consumers('OPENAI_API_KEY')).toEqual([
      { extensionId: 'nox.provider.openai', location: 'providers.main.apiKey' },
    ]);
  });

  test('lists what configuration names, so an unfilled credential is visible', async () => {
    const application = await boot({ secrets: {} });
    const listed = await application.services.get(secretStoreService).list();

    // The bug this whole surface exists for: before, a referenced-but-unstored
    // secret appeared nowhere at all.
    expect(listed).toMatchObject([
      {
        references: [{ location: 'providers.main.apiKey', secretId: 'OPENAI_API_KEY' }],
        secretId: 'OPENAI_API_KEY',
        stored: false,
      },
    ]);
  });

  test('releases a memory the configuration has replaced, and only once its agents are rebuilt', async () => {
    const ledger = join(temporary('nox-ledger-'), 'released.log');
    const extensionsDir = join(import.meta.dir, 'runtime', 'fixtures');
    const memory = { ledger, type: 'disposable_test' };
    const env = await seed({
      blueprints: { nox: { ...NOX, memory: { id: 'disposable_test' } } },
      configWatch: true,
      extensionsDir,
      memories: { disposable_test: memory },
    });
    const configDir = env.CONFIG_DIR;
    if (configDir === undefined) throw new Error('Expected a config directory.');
    booted = await bootstrap({ env, logger: silentLogger });
    expect(booted.getAgent('nox')).toBeDefined();
    expect(existsSync(ledger)).toBeFalse();

    // A new instance replaces the old one, and the agent holding it is rebuilt
    // in the same pass because its signature folds in the memory's config.
    writeFileSync(
      join(configDir, 'memories.json'),
      JSON.stringify({ disposable_test: { ...memory, ledger: `${ledger}.2` } }),
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(ledger)) break;
      await Bun.sleep(10);
    }

    expect(readFileSync(ledger, 'utf8').trim()).toBe('released');
    expect(booted.state).toBe('running');
  });

  test('offers the local engine without configuring it on the operator’s behalf', async () => {
    const application = await boot();
    const configured = application.services.get(configService).get('providers');
    const summary = application.services
      .get(configAdminService)
      .sections()
      .find((section) => section.key === 'providers');

    // Registration makes the type valid and lets settings offer its owned
    // singleton entry. It does not mean this installation chose to run a local
    // model, so no entry may be invented in providers.json.
    expect(application.contributions.get(providers, 'local')?.extensionId).toBe(
      'nox.provider.local',
    );
    expect(configured).not.toHaveProperty('local');
    expect(summary?.contributions).toContainEqual({
      configured: false,
      extensionId: 'nox.provider.local',
      instances: 'single',
      type: 'local',
    });
  });

  test('configures a provider that only embeds, without a place of its own', async () => {
    const application = await boot({
      blueprints: { nox: NOX },
      extensionsDir: join(import.meta.dir, 'runtime', 'fixtures'),
      providers: { ...PROVIDERS, counting_test: { type: 'counting_test' } },
    });
    const contribution = application.contributions.get(providers, 'counting_test');
    const provider = contribution?.value.create({ type: 'counting_test' } as never);

    // A service that cannot chat is still an ordinary provider: what it can do
    // is what it implements, not which section it was configured in.
    expect(isChatCapable(provider)).toBeFalse();
    expect(isEmbeddingCapable(provider)).toBeTrue();

    const result = isEmbeddingCapable(provider)
      ? await provider.embed({ texts: ['first', 'second and longer'] })
      : undefined;
    expect(result?.vectors).toHaveLength(2);
    expect(result?.dimensions).toBe(4);
    for (const vector of result?.vectors ?? []) {
      expect(Math.hypot(...vector)).toBeCloseTo(1, 10);
    }
  });

  test('lets an extension use a model it did not contribute', async () => {
    const application = await boot({
      extensionsDir: join(import.meta.dir, 'runtime', 'fixtures'),
      memories: {
        embedding_test: {
          embedding: { model: 'counting', provider: 'counting_test' },
          type: 'embedding_test',
        },
      },
      providers: {
        ...PROVIDERS,
        counting_test: {
          modelConfigs: [{ dimensions: 4, kind: 'embedding', modelId: 'counting' }],
          type: 'counting_test',
        },
      },
    });
    const status = application.services
      .get(configAdminService)
      .runtimeStatuses()
      .find((component) => component.kind === 'memory' && component.id === 'embedding_test');
    expect(status?.state).toBe('active');

    const memory = application.contributions.get(memories, 'embedding_test')?.value.create({
      embedding: { model: 'counting', provider: 'counting_test' },
      type: 'embedding_test',
    } as never);
    const recalled = await memory?.recall({
      context: [],
      maxTokens: 128,
      query: 'what did I say',
      scope: {
        agentId: 'nox',
        principal: { issuer: 'web', subject: 'esteban' },
        sessionId: 'session',
      },
      signal: AbortSignal.timeout(5_000),
    });

    // The whole point of the service: a memory reached a configured embedding
    // model through the provider an operator named, having contributed neither.
    expect(recalled?.memories[0]?.metadata).toMatchObject({
      dimensions: 4,
      modelId: 'counting',
      provider: 'counting_test',
    });
    expect(recalled?.memories[0]?.text.split(',')).toHaveLength(4);
  });

  test('reports a model a memory names but no provider serves, while it is being built', async () => {
    const application = await boot({
      extensionsDir: join(import.meta.dir, 'runtime', 'fixtures'),
      memories: {
        embedding_test: {
          embedding: { model: 'absent', provider: 'counting_test' },
          type: 'embedding_test',
        },
      },
      providers: {
        ...PROVIDERS,
        counting_test: {
          modelConfigs: [{ dimensions: 4, kind: 'embedding', modelId: 'counting' }],
          type: 'counting_test',
        },
      },
    });
    const status = application.services
      .get(configAdminService)
      .runtimeStatuses()
      .find((component) => component.kind === 'memory' && component.id === 'embedding_test');

    // Taken when the contribution is created rather than at the first recall,
    // so the mistake is a component that says it is unavailable instead of one
    // that looks healthy until a conversation needs it.
    expect(status?.state).toBe('unavailable');
    expect(status?.error).toContain('serves no embedding model "absent"');
    expect(application.state).toBe('running');
  });

  test('refuses a provider that cannot embed where a memory needs vectors', async () => {
    const application = await boot({
      extensionsDir: join(import.meta.dir, 'runtime', 'fixtures'),
      memories: {
        embedding_test: {
          embedding: { model: 'gpt-test', provider: 'main' },
          type: 'embedding_test',
        },
      },
    });
    const status = application.services
      .get(configAdminService)
      .runtimeStatuses()
      .find((component) => component.kind === 'memory' && component.id === 'embedding_test');

    expect(status?.state).toBe('unavailable');
    expect(status?.error).toContain('serves no embedding model');
  });

  test('refuses to compose an agent on a provider that serves no chat model', async () => {
    const application = await boot({
      blueprints: { nox: { ...NOX, provider: 'counting_test' } },
      extensionsDir: join(import.meta.dir, 'runtime', 'fixtures'),
      providers: { ...PROVIDERS, counting_test: { type: 'counting_test' } },
    });

    // Reported as the configuration mistake it is, rather than failing at the
    // first request the agent would have tried to answer.
    expect(application.getAgent('nox')).toBeUndefined();
    const failure = application.services
      .get(configAdminService)
      .runtimeStatuses()
      .find((component) => component.kind === 'agent' && component.id === 'nox');
    expect(failure?.error).toContain('serves no chat model');
  });

  test('reports what each provider serves, declared and merely offered', async () => {
    const application = await boot({
      blueprints: { nox: { ...NOX, provider: 'counting_test' } },
      extensionsDir: join(import.meta.dir, 'runtime', 'fixtures'),
      providers: {
        counting_test: { type: 'counting_test' },
        local: {
          embedding: { dimensions: 384, enabled: true, model: 'test/embed' },
          llm: { enabled: true, model: 'test/chat' },
          type: 'local',
        },
      },
    });

    const inventory = await application.services.get(configAdminService).providerInventory();

    // What an entry declares, with the metadata the declaration exists for.
    const local = inventory.find(({ id }) => id === 'local');
    expect(local?.available).toBe(true);
    expect(local?.kinds).toEqual(['chat', 'embedding']);
    expect(local?.models).toEqual([
      { configured: true, kind: 'chat', modelId: 'test/chat' },
      { configured: true, dimensions: 384, kind: 'embedding', modelId: 'test/embed' },
    ]);

    // And what only the instance knows: a model nothing has declared, which is
    // the whole point — it can now be chosen instead of typed from memory.
    const counting = inventory.find(({ id }) => id === 'counting_test');
    expect(counting?.reported).toBe(true);
    expect(counting?.kinds).toEqual(['embedding']);
    expect(counting?.models).toEqual([{ configured: false, modelId: 'counting' }]);
  });

  test('reports why a provider could not list its models instead of an empty list', async () => {
    const application = await boot({
      blueprints: { nox: { ...NOX, provider: 'unlistable_test' } },
      extensionsDir: join(import.meta.dir, 'runtime', 'fixtures'),
      providers: { unlistable_test: { type: 'unlistable_test' } },
    });

    const inventory = await application.services.get(configAdminService).providerInventory();
    const provider = inventory.find(({ id }) => id === 'unlistable_test');

    expect(provider?.available).toBe(true);
    expect(provider?.reported).toBe(false);
    expect(provider?.reportProblem).toContain('no model list');
    expect(provider?.models).toEqual([]);
  });

  test('refuses an embedding model where an agent needs a conversational one', async () => {
    const application = await boot({
      blueprints: { nox: { ...NOX, model: 'test/embed', provider: 'local' } },
      providers: {
        local: {
          embedding: { dimensions: 384, enabled: true, model: 'test/embed' },
          llm: { enabled: true, model: 'test/chat' },
          type: 'local',
        },
      },
    });

    expect(application.getAgent('nox')).toBeUndefined();
    const failure = application.services
      .get(configAdminService)
      .runtimeStatuses()
      .find((component) => component.kind === 'agent' && component.id === 'nox');
    expect(failure?.error).toContain('configured for embeddings, not conversation');
  });

  test('brings up the semantic memory against configured models and its own schema', async () => {
    const dataDir = temporary('nox-data-');
    const application = await boot({
      blueprints: { nox: { ...NOX, memory: { id: 'semantic' } } },
      dataDir,
      extensionsDir: join(import.meta.dir, 'runtime', 'fixtures'),
      memories: {
        semantic: {
          embedding: { model: 'counting', provider: 'counting_test' },
          extraction: { model: 'gpt-test', provider: 'main' },
          type: 'semantic',
        },
      },
      providers: {
        ...PROVIDERS,
        counting_test: {
          modelConfigs: [{ dimensions: 4, kind: 'embedding', modelId: 'counting' }],
          type: 'counting_test',
        },
      },
    });
    const status = application.services
      .get(configAdminService)
      .runtimeStatuses()
      .find((component) => component.kind === 'memory' && component.id === 'semantic');

    // The agent composed on it, which is the only proof that every reference in
    // memories.json resolved: two models, a schema, and a vector table whose
    // width came from the embedding model rather than from a migration.
    expect(status?.state).toBe('active');
    expect(application.getAgent('nox')).toBeDefined();

    const database = new SqliteConnection(join(dataDir, 'extensions.db'));
    try {
      const tables = database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
        )
        .all()
        .map((row) => row.name);

      expect(tables).toContain('semantic_episodes');
      expect(tables).toContain('semantic_facts');
      expect(tables).toContain('semantic_fact_provenance');
      // Created at startup and not by the migration, because its width is the
      // configured model's and a migration is the same everywhere.
      expect(tables).toContain('semantic_fact_vectors');
    } finally {
      database.close(false);
    }
  });

  test('refuses a memory whose extraction provider cannot chat at all', async () => {
    const application = await boot({
      extensionsDir: join(import.meta.dir, 'runtime', 'fixtures'),
      memories: {
        semantic: {
          embedding: { model: 'counting', provider: 'counting_test' },
          extraction: { model: 'counting', provider: 'counting_test' },
          type: 'semantic',
        },
      },
      providers: {
        ...PROVIDERS,
        counting_test: {
          modelConfigs: [{ dimensions: 4, kind: 'embedding', modelId: 'counting' }],
          type: 'counting_test',
        },
      },
    });
    const status = application.services
      .get(configAdminService)
      .runtimeStatuses()
      .find((component) => component.kind === 'memory' && component.id === 'semantic');

    expect(status?.state).toBe('unavailable');
    expect(status?.error).toContain('serves no chat model');
  });

  test('refuses an embedding model where a memory needs to extract', async () => {
    const application = await boot({
      memories: {
        semantic: {
          embedding: { model: 'test/embed', provider: 'local' },
          extraction: { model: 'test/embed', provider: 'local' },
          type: 'semantic',
        },
      },
      providers: {
        local: {
          embedding: { dimensions: 384, enabled: true, model: 'test/embed' },
          llm: { enabled: true, model: 'test/chat' },
          type: 'local',
        },
      },
    });
    const status = application.services
      .get(configAdminService)
      .runtimeStatuses()
      .find((component) => component.kind === 'memory' && component.id === 'semantic');

    // A provider that can chat, asked for a model declared as an embedding one.
    // Refused in the words an operator already sees when an agent does this,
    // rather than in a second vocabulary invented for memories.
    expect(status?.state).toBe('unavailable');
    expect(status?.error).toContain('configured for embeddings, not conversation');
  });

  test('releases a tool set the configuration has replaced', async () => {
    const ledger = join(temporary('nox-ledger-'), 'released.log');
    const toolSet = { ledger, type: 'disposable_test' };
    const env = await seed({
      blueprints: { nox: { ...NOX, toolSets: { direct: ['disposable_test'] } } },
      configWatch: true,
      extensionsDir: join(import.meta.dir, 'runtime', 'fixtures'),
      toolSets: { disposable_test: toolSet },
    });
    const configDir = env.CONFIG_DIR;
    if (configDir === undefined) throw new Error('Expected a config directory.');
    booted = await bootstrap({ env, logger: silentLogger });
    expect(booted.getAgent('nox')).toBeDefined();
    expect(existsSync(ledger)).toBeFalse();

    writeFileSync(
      join(configDir, 'toolsets.json'),
      JSON.stringify({ disposable_test: { ...toolSet, ledger: `${ledger}.2` } }),
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(ledger)) break;
      await Bun.sleep(10);
    }

    expect(readFileSync(ledger, 'utf8').trim()).toBe('released');
    expect(booted.state).toBe('running');
  });

  test('releases what it still holds when the application stops', async () => {
    const ledger = join(temporary('nox-ledger-'), 'released.log');
    await boot({
      blueprints: { nox: { ...NOX, memory: { id: 'disposable_test' } } },
      extensionsDir: join(import.meta.dir, 'runtime', 'fixtures'),
      memories: { disposable_test: { ledger, type: 'disposable_test' } },
    });
    expect(existsSync(ledger)).toBeFalse();

    await booted?.stop();
    booted = undefined;

    // `released` rather than `still-running`, and present at all: shutdown waits
    // for a memory's disposal to finish. A memory owns its own consolidation, so
    // this is what keeps a background pass from being cut off mid-write — and it
    // is why consolidation needs no scheduler from the host.
    expect(readFileSync(ledger, 'utf8').trim()).toBe('released');
  });
});
