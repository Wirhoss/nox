import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { providers, toolSets } from '@nox/extension-api';
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
      modelId: 'gpt-test',
      outputModalities: ['text'],
    });
    expect(application.getAgent('nox')?.systemPrompt).toBe('be exact');
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
        nox: { ...NOX, toolSets: { direct: ['internet'], routed: [] } },
      },
      secrets: { OPENAI_API_KEY: 'sk-test', SEARXNG_API_KEY: 'search-secret' },
      toolSets: {
        internet: {
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
    expect(application.services.get(configService).get('toolSets')).toHaveProperty('internet');
    expect(application.services.get(secretStoreService).consumers('SEARXNG_API_KEY')).toEqual([
      { extensionId: 'nox.toolset.web', location: 'toolSets.internet.search.apiKey' },
    ]);

    const session = await application.openSession('nox');
    await application.closeSession(session.sessionId);
  });

  test('composes the configuration tool set against the shared administration service', async () => {
    const application = await boot({
      blueprints: {
        nox: { ...NOX, toolSets: { direct: ['control'], routed: [] } },
      },
      toolSets: {
        control: {
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
    const internet = {
      extract: { module: 'crawl4ai', url: 'https://crawl.example.test' },
      search: { module: 'searxng', url: 'https://search.example.test' },
      type: 'web',
    };

    // Two agents over one configured instance, which is the case the allowlist
    // exists for: the instance is shared, so the cut cannot live on it.
    const application = await boot({
      app: { api: { port: 0 } },
      blueprints: {
        nox: { ...NOX, toolSets: { direct: [{ id: 'internet', tools: ['web_search'] }] } },
        typo: { ...NOX, toolSets: { direct: [{ id: 'internet', tools: ['web_crawl'] }] } },
      },
      toolSets: { internet },
    });

    const session = await application.openSession('nox');
    await application.closeSession(session.sessionId);

    // A name the instance does not expose fails where the set and the name are
    // both in hand, rather than granting nothing in silence. It surfaces when
    // the session snapshots its tools, which is where grants are resolved.
    let error: unknown;
    try {
      await application.openSession('typo');
    } catch (reason) {
      error = reason;
    }

    expect(String(error)).toContain('does not expose tool web_crawl');
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

  test('applies blueprint generation settings over provider model defaults', async () => {
    const application = await boot({
      blueprints: {
        nox: { ...NOX, generation: { maxTokens: 1200, temperature: 0.2 } },
      },
      providers: {
        main: {
          ...PROVIDERS.main,
          modelConfigs: [{ contextWindow: 4096, modelId: 'gpt-test', temperature: 0.8 }],
        },
      },
    });

    expect(application.getAgent('nox')?.model).toMatchObject({
      contextWindow: 4096,
      maxTokens: 1200,
      temperature: 0.2,
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
    expect(application.services.get(configService).get('providers').main?.apiKey).toMatchObject({
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
});
