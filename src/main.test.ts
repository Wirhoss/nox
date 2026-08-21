import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { providers } from './extensions/contribution-points/providers';
import { silentLogger } from './logger/logger';
import { bootstrap, type NoxRuntime } from './main';

import type { EnvSource } from './config/env';

const directories: string[] = [];
let booted: NoxRuntime | undefined;

afterEach(async () => {
  await booted?.shutdown();
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

async function boot(overrides: EnvSource = {}): Promise<NoxRuntime> {
  booted = await bootstrap({
    env: environment(overrides),
    logger: silentLogger,
    systemPrompt: 'be exact',
  });
  return booted;
}

describe('bootstrap', () => {
  test('wires an agent from a provider nothing in the kernel imported', async () => {
    const runtime = await boot();

    expect(runtime.application.state).toBe('running');
    expect(
      runtime.application.contributions.get(providers, 'openai_completions')?.extensionId,
    ).toBe('nox.provider.openai');
    expect(runtime.agent.model).toEqual({ modelId: 'gpt-test', type: 'text' });
    expect(runtime.agent.systemPrompt).toBe('be exact');
  });

  test('opens storage under the configured data directory', async () => {
    const dataDir = temporary('nox-data-');
    const runtime = await boot({ DATA_DIR: dataDir });

    expect(runtime.database.isOpen).toBe(true);
    expect(runtime.database.path).toBe(join(dataDir, 'nox.db'));
  });

  test('opens a session that persists and resumes by id', async () => {
    const runtime = await boot();

    const session = await runtime.agent.openSession({ sessionId: 'first-run' });
    expect(session.sessionId).toBe('first-run');
    await session.stop();

    const resumed = await runtime.agent.openSession({ sessionId: 'first-run' });
    expect(resumed.sessionId).toBe('first-run');
    await resumed.stop();
  });

  test('shutdown releases extensions and storage, and is idempotent', async () => {
    const runtime = await boot();

    await runtime.shutdown();
    await runtime.shutdown();

    expect(runtime.application.state).toBe('stopped');
    expect(runtime.database.isOpen).toBe(false);
    expect(runtime.application.contributions.has(providers, 'openai_completions')).toBe(false);
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
