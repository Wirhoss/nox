import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ChatProvider, EXTENSION_EXTERNAL_PACKAGES, providers, toolSets } from '@nox/extension-api';
import { afterEach, describe, expect, test } from 'bun:test';

import { NoxApplication } from '../application';
import { SecretHandle } from '../config/secrets';
import { silentLogger } from '../logger/logger';
import { discoverExtensions } from './loader';

import type { MessageContent } from '@nox/extension-api';

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  // Keep generated consumers below the repository so Bun resolves the workspace
  // package exactly as a separately built extension would resolve its dev runtime.
  const directory = mkdtempSync(join(import.meta.dir, '.extension-consumer-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      // Windows can retain a just-imported generated module briefly.
    }
  }
});

async function compileExtension(
  entrypoint: string,
  id: string,
  services: readonly string[] = [],
): Promise<Awaited<ReturnType<typeof discoverExtensions>>> {
  const root = temporaryRoot();
  const packageDirectory = join(root, id);
  mkdirSync(packageDirectory, { recursive: true });

  const output = await Bun.build({
    entrypoints: [entrypoint],
    // The same declaration a real extension build uses, so this test cannot
    // pass on a list that has quietly drifted from the one that ships.
    external: [...EXTENSION_EXTERNAL_PACKAGES],
    minify: true,
    naming: 'extension.js',
    outdir: packageDirectory,
    target: 'bun',
  });
  if (!output.success) {
    throw new AggregateError(output.logs, `Could not compile external extension ${id}.`);
  }

  writeFileSync(
    join(packageDirectory, 'nox-extension.json'),
    JSON.stringify({
      engines: { extensionApi: '^0.1.0', nox: '^0.1.0' },
      id,
      main: 'extension.js',
      schemaVersion: 1,
      services,
      version: '1.0.0',
    }),
  );

  return discoverExtensions({
    directories: [{ directory: root, origin: 'installed' }],
    logger: silentLogger,
    noxVersion: '0.1.0',
  });
}

describe('external Extension API consumers', () => {
  test('compiles, discovers, activates, and executes the standalone example', async () => {
    const discovered = await compileExtension(
      resolve(
        import.meta.dir,
        '..',
        '..',
        'examples',
        'extensions',
        'greeting-toolset',
        'src',
        'extension.ts',
      ),
      'example.greeting',
    );
    const app = new NoxApplication({ extensions: discovered.extensions });
    await app.start();

    const contribution = app.contributions.get(toolSets, 'greeting');
    if (contribution === undefined) throw new Error('Greeting contribution did not activate.');
    const greetingConfig = contribution.value.configSchema.parse({
      salutation: 'Hola',
      type: 'greeting',
    });
    const toolSet = contribution.value.create(greetingConfig);
    const execution = toolSet.prepare('greet', { name: 'Nox' });
    const response: MessageContent[] =
      execution.type === 'immediate'
        ? await execution.run({ abortSignal: new AbortController().signal })
        : [];

    expect(response).toEqual([{ text: 'Hola, Nox!', type: 'text' }]);
    expect(discovered.catalog.list()[0]?.state).toBe('active');
    await app.stop();
  });

  test('a compiled provider accepts host secret handles for multiple instances', async () => {
    const discovered = await compileExtension(
      resolve(import.meta.dir, 'builtin', 'providers', 'openai', 'extension.ts'),
      // Compiled and installed the way a third party would, so it takes a
      // third-party ID: `nox.` is the core's, and discovery refuses it here.
      'test.provider.openai',
      ['nox.artifact-pipeline'],
    );
    const app = new NoxApplication({ extensions: discovered.extensions });
    await app.start();

    const factory = app.contributions.get(providers, 'openai_completions')?.value;
    const sharedRuntimeDefaults = {
      maxRetries: 2,
      maxRetryDelayMs: 30_000,
      retryDelayMs: 500,
      type: 'openai_completions',
    };
    const openAiConfig = {
      ...sharedRuntimeDefaults,
      apiKey: new SecretHandle('OPENAI_API_KEY', 'first-value'),
      baseUrl: 'https://api.openai.com/v1',
    };
    const deepSeekConfig = {
      ...sharedRuntimeDefaults,
      apiKey: new SecretHandle('DEEPSEEK_API_KEY', 'second-value'),
      baseUrl: 'https://api.deepseek.com/v1',
    };
    const first = factory?.create(openAiConfig);
    const second = factory?.create(deepSeekConfig);

    expect(first).toBeInstanceOf(ChatProvider);
    expect(second).toBeInstanceOf(ChatProvider);
    await app.stop();
  });
});
