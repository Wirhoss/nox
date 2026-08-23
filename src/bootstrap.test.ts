import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { ApiServer } from './api/server';
import { bootstrap } from './bootstrap';
import { SecretStore } from './config/secrets';
import { Database } from './database/database';
import { providers } from './extensions/contribution-points/providers';
import { toolSets } from './extensions/contribution-points/toolsets';
import { silentLogger } from './logger/logger';
import {
  artifactPipelineService,
  configService,
  databaseService,
  loggerService,
  secretStoreService,
} from './services';

import type { NoxApplication } from './application';
import type { EnvSource } from './config/env';

const directories: string[] = [];
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
  } finally {
    await database.close();
  }

  return { CONFIG_DIR: configDir, DATA_DIR: dataDir, NODE_ENV: 'test' };
}

async function boot(options: BootOptions = {}): Promise<NoxApplication> {
  booted = await bootstrap({ env: await seed(options), logger: silentLogger });
  return booted;
}

/** Resolves with the error bootstrap rejected with, or undefined if it booted. */
async function failure(options: BootOptions): Promise<unknown> {
  const result: unknown = await bootstrap({
    env: await seed(options),
    logger: silentLogger,
  }).catch((error: unknown) => error);
  if (result instanceof Error) return result;

  booted = result as NoxApplication;
  return undefined;
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

  test('carries a blueprint allowlist through to the tools a session opens with', async () => {
    const internet = {
      extract: { url: 'https://crawl.example.test' },
      search: { url: 'https://search.example.test' },
      type: 'web',
    };

    // Two agents over one configured instance, which is the case the allowlist
    // exists for: the instance is shared, so the cut cannot live on it.
    const application = await boot({
      app: { api: { port: 0 }, chat: { defaultAgent: 'nox' } },
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
      app: { api: { port: 0 }, chat: { defaultAgent: 'nox' } },
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
          modelConfigs: [{ contextWindow: 4096, modelId: 'gpt-test', type: 'text' }],
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
          modelConfigs: [
            { contextWindow: 4096, modelId: 'gpt-test', temperature: 0.8, type: 'text' },
          ],
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
    expect(application.services.get(databaseService).isOpen).toBe(true);
    expect(application.services.get(loggerService)).toBe(silentLogger);
    expect(application.services.get(secretStoreService).consumers('OPENAI_API_KEY')).toEqual([
      { extensionId: 'nox.provider.openai', location: 'providers.main.apiKey' },
    ]);
  });

  test('opens storage under the configured data directory', async () => {
    const dataDir = temporary('nox-data-');
    const application = await boot({ dataDir });

    expect(application.services.get(databaseService).path).toBe(join(dataDir, 'nox.db'));
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
    const database = application.services.get(databaseService);
    await application.openSession('nox');

    await application.stop();
    await application.stop();

    expect(application.state).toBe('stopped');
    expect(application.sessions).toEqual([]);
    expect(database.isOpen).toBe(false);
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

  test('requires a web default only when more than one agent exists', async () => {
    const error = await failure({
      app: { api: { port: 0 } },
      blueprints: {
        mailroom: { ...NOX, systemPrompt: 'read the mail' },
        watcher: { ...NOX, systemPrompt: 'watch' },
      },
    });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('app.chat.defaultAgent');
  });

  test('releases the port when composing fails, rather than holding it', async () => {
    const api = { host: '127.0.0.1', port: 39_518 };

    expect(await failure({ app: { api }, blueprints: {} })).toBeInstanceOf(Error);

    // A boot that threw left nothing running, so the next one can listen where
    // the last one did.
    const application = await boot({ app: { api } });
    expect(application.state).toBe('running');
  });

  test('refuses to boot with no blueprint at all, saying where they go', async () => {
    const error = await failure({ blueprints: {} });

    expect(String(error)).toContain('blueprints');
  });

  test('refuses to boot when a blueprint names an unconfigured provider', async () => {
    const error = await failure({ blueprints: { nox: { ...NOX, provider: 'missing' } } });

    expect(String(error)).toContain('missing');
    expect(String(error)).toContain('main');
  });

  test('refuses to boot when a blueprint names an unconfigured tool set', async () => {
    const error = await failure({
      blueprints: {
        nox: { ...NOX, toolSets: { direct: ['missing'], routed: [] } },
      },
    });

    expect(String(error)).toContain('missing');
    expect(String(error)).toContain('toolsets.json');
  });

  test('rejects a tool-set kind nobody contributed', async () => {
    const error = await failure({
      toolSets: { internet: { type: 'ghost' } },
    });

    expect(String(error)).toContain('toolsets.json');
    expect(String(error)).toContain('web');
  });

  test('rejects a blueprint missing what the schema requires', async () => {
    const error = await failure({ blueprints: { nox: { provider: 'main' } } });

    expect(String(error)).toContain('nox.json');
    expect(String(error)).toContain('model');
  });

  test('rejects a provider entry of a kind nobody contributed, listing the kinds', async () => {
    const error = await failure({
      providers: { main: { baseUrl: 'https://api.example.test/v1', type: 'anthropic' } },
    });

    expect(String(error)).toContain('providers.json');
    expect(String(error)).toContain('openai_completions');
  });

  test('rejects a provider entry missing what its own schema requires', async () => {
    const error = await failure({ providers: { main: { type: 'openai_completions' } } });

    // `baseUrl` is required by the adapter schema, and the adapter is the only
    // thing that knows that, which is why it hands the schema over.
    expect(String(error)).toContain('baseUrl');
  });

  test('refuses a plaintext credential in ordinary configuration', async () => {
    // The position is declared by the adapter's schema as a reference and only a
    // reference, so a literal is rejected by the same parse that validates the
    // rest of the entry.
    const error = await failure({
      providers: { main: { ...PROVIDERS.main, apiKey: 'plaintext' } },
    });

    expect(String(error)).toContain('apiKey');
    expect(String(error)).toContain('$secret');
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
