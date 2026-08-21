import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { bootstrap } from './bootstrap';
import { providers } from './extensions/contribution-points/providers';
import { silentLogger } from './logger/logger';
import { configService, databaseService, loggerService } from './services';

import type { NoxApplication } from './application';
import type { EnvSource } from './config/env';

const directories: string[] = [];
let booted: NoxApplication | undefined;

/** What a working installation looks like: one blueprint, one provider. */
const NOX = { model: 'gpt-test', provider: 'main', systemPrompt: 'be exact' };
const PROVIDERS = {
  main: {
    apiKey: 'sk-test',
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
  dataDir?: string;
  providers?: unknown;
}

function seed(options: BootOptions = {}): EnvSource {
  const configDir = temporary('nox-config-');
  writeFileSync(join(configDir, 'app.json'), JSON.stringify(options.app ?? {}));
  writeFileSync(join(configDir, 'providers.json'), JSON.stringify(options.providers ?? PROVIDERS));

  mkdirSync(join(configDir, 'blueprints'), { recursive: true });
  for (const [name, blueprint] of Object.entries(options.blueprints ?? { nox: NOX })) {
    writeFileSync(join(configDir, 'blueprints', `${name}.json`), JSON.stringify(blueprint));
  }

  return {
    CONFIG_DIR: configDir,
    DATA_DIR: options.dataDir ?? temporary('nox-data-'),
    NODE_ENV: 'test',
  };
}

async function boot(options: BootOptions = {}): Promise<NoxApplication> {
  booted = await bootstrap({ env: seed(options), logger: silentLogger });
  return booted;
}

/** Resolves with the error bootstrap rejected with, or undefined if it booted. */
async function failure(options: BootOptions): Promise<unknown> {
  const result: unknown = await bootstrap({ env: seed(options), logger: silentLogger }).catch(
    (error: unknown) => error,
  );
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
    expect(application.getAgent('nox')?.model).toEqual({ modelId: 'gpt-test', type: 'text' });
    expect(application.getAgent('nox')?.systemPrompt).toBe('be exact');
  });

  test('registers one agent per file in the blueprints directory', async () => {
    const application = await boot({
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
    expect(application.services.get(databaseService).isOpen).toBe(true);
    expect(application.services.get(loggerService)).toBe(silentLogger);
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
});
