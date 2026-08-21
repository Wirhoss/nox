import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { bootstrap, DEFAULT_AGENT_ID } from './bootstrap';
import { providers } from './extensions/contribution-points/providers';
import { silentLogger } from './logger/logger';
import { configService, databaseService, loggerService } from './services';

import type { NoxApplication } from './application';
import type { EnvSource } from './config/env';

const directories: string[] = [];
let booted: NoxApplication | undefined;

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

function environment(overrides: EnvSource = {}): EnvSource {
  return {
    CONFIG_DIR: temporary('nox-config-'),
    DATA_DIR: temporary('nox-data-'),
    NODE_ENV: 'test',
    OPENAI_API_KEY: 'sk-test',
    OPENAI_MODEL: 'gpt-test',
    ...overrides,
  };
}

async function boot(overrides: EnvSource = {}): Promise<NoxApplication> {
  booted = await bootstrap({
    env: environment(overrides),
    logger: silentLogger,
    systemPrompt: 'be exact',
  });
  return booted;
}

describe('bootstrap', () => {
  test('wires an agent from a provider nothing in the kernel imported', async () => {
    const application = await boot();

    expect(application.state).toBe('running');
    expect(application.contributions.get(providers, 'openai_completions')?.extensionId).toBe(
      'nox.provider.openai',
    );
    expect(application.agentIds).toEqual([DEFAULT_AGENT_ID]);
    expect(application.getAgent(DEFAULT_AGENT_ID)?.model).toEqual({
      modelId: 'gpt-test',
      type: 'text',
    });
    expect(application.getAgent(DEFAULT_AGENT_ID)?.systemPrompt).toBe('be exact');
  });

  test('hands the host services to the application rather than keeping them', async () => {
    const application = await boot();

    expect(application.services.get(configService).get('app').logLevel).toBeString();
    expect(application.services.get(databaseService).isOpen).toBe(true);
    expect(application.services.get(loggerService)).toBe(silentLogger);
  });

  test('opens storage under the configured data directory', async () => {
    const dataDir = temporary('nox-data-');
    const application = await boot({ DATA_DIR: dataDir });

    expect(application.services.get(databaseService).path).toBe(join(dataDir, 'nox.db'));
  });

  test('opens a session that persists and resumes by id', async () => {
    const application = await boot();

    const session = await application.openSession(DEFAULT_AGENT_ID, { sessionId: 'first-run' });
    expect(session.sessionId).toBe('first-run');
    await application.closeSession('first-run');

    const resumed = await application.openSession(DEFAULT_AGENT_ID, { sessionId: 'first-run' });
    expect(resumed.sessionId).toBe('first-run');
    await application.closeSession('first-run');
  });

  test('stop releases sessions, extensions and storage, and is idempotent', async () => {
    const application = await boot();
    const database = application.services.get(databaseService);
    await application.openSession(DEFAULT_AGENT_ID);

    await application.stop();
    await application.stop();

    expect(application.state).toBe('stopped');
    expect(application.sessions).toEqual([]);
    expect(database.isOpen).toBe(false);
    expect(application.contributions.has(providers, 'openai_completions')).toBe(false);
  });

  test('refuses to boot without an API key, and says which variable', async () => {
    const failure: unknown = await bootstrap({
      env: environment({ OPENAI_API_KEY: undefined }),
      logger: silentLogger,
    })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RangeError);
    expect((failure as RangeError).message).toContain('OPENAI_API_KEY');
  });

  test('refuses to boot without a model id', async () => {
    const failure: unknown = await bootstrap({
      env: environment({ OPENAI_MODEL: undefined }),
      logger: silentLogger,
    })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect((failure as RangeError).message).toContain('OPENAI_MODEL');
  });
});
