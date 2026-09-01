import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { silentLogger } from '../../logger/logger';
import { activateConfined } from './extension';
import { ExtensionProcess } from './host';

import type { Logger } from '../../logger/logger';
import type { ConfinedContribution, CrossedConfigurable } from './extension';
import type { ExtensionManifest, ToolSet } from '@nox/extension-api';

const PARROT = join(import.meta.dir, 'fixtures', 'parrot.ts');

const manifest = {
  displayName: 'Parrot',
  engines: { extensionApi: '*', nox: '*' },
  id: 'test.parrot',
  main: 'parrot.ts',
  name: 'parrot',
  publisher: 'test',
  services: ['nox.logger'],
  version: '1.0.0',
} as unknown as ExtensionManifest;

async function activated(logger: Logger = silentLogger): Promise<{
  contributions: readonly ConfinedContribution[];
  dispose: () => Promise<void>;
  host: ExtensionProcess;
}> {
  const host = new ExtensionProcess({
    allowances: [],
    extensionId: manifest.id,
    logger,
    runUnconfined: true,
  });
  await host.load(PARROT);
  const contributions = await activateConfined(host, manifest);
  return { contributions, dispose: () => host.dispose(), host };
}

function configurable(
  contributions: readonly ConfinedContribution[],
  id: string,
): CrossedConfigurable {
  const found = contributions.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`No contribution "${id}".`);
  return found.value as CrossedConfigurable;
}

describe('activateConfined', () => {
  test('activates an extension in its own process and reports what it contributed', async () => {
    const { contributions, dispose } = await activated();
    try {
      expect([...contributions].map((entry) => `${entry.point}:${entry.id}`).sort()).toEqual([
        'nox.authorities:test.parrot.say',
        'nox.toolsets:parrot',
      ]);

      // A point whose values are already data crosses as itself.
      const authority = contributions.find((entry) => entry.point === 'nox.authorities');
      expect(authority?.value).toEqual({ description: 'Let the parrot repeat its word.' });
    } finally {
      await dispose();
    }
  });

  test('rebuilds the configuration schema on this side', async () => {
    const { contributions, dispose } = await activated();
    try {
      const parrot = configurable(contributions, 'parrot');
      expect(parrot.instances).toBe('many');
      // A real Zod object, with the discriminating literal intact — which is
      // what the config loader routes an operator's entry by.
      expect(parrot.configSchema.shape.type.value).toBe('parrot');
      expect(parrot.configSchema.safeParse({ type: 'parrot', word: 'hello' })).toMatchObject({
        data: { excitement: 1, word: 'hello' },
        success: true,
      });
      expect(parrot.configSchema.safeParse({ type: 'parrot' }).success).toBe(false);
    } finally {
      await dispose();
    }
  });

  test('builds a working tool set from a configured entry', async () => {
    const { contributions, dispose } = await activated();
    try {
      const parrot = configurable(contributions, 'parrot');
      const toolSet = (await parrot.create({
        excitement: 2,
        type: 'parrot',
        word: 'hi',
      })) as ToolSet;

      expect(toolSet.name).toBe('parrot');
      expect(Object.keys(toolSet.declarations)).toEqual(['say']);
      const prepared = await toolSet.prepare('say', { times: 3 });
      if (prepared.type !== 'immediate') throw new Error('unreachable');
      const said = await prepared.run({ abortSignal: new AbortController().signal });
      expect(said).toEqual([{ text: 'hi!! hi!! hi!!', type: 'text' }]);
    } finally {
      await dispose();
    }
  });

  test('builds two independent instances of the same contribution', async () => {
    // The reason handles exist. One extension configured twice is ordinary, and
    // a child that could hold one instance would have made the boundary
    // narrower than the contract it carries.
    const { contributions, dispose } = await activated();
    try {
      const parrot = configurable(contributions, 'parrot');
      const quiet = (await parrot.create({ excitement: 0, type: 'parrot', word: 'a' })) as ToolSet;
      const loud = (await parrot.create({ excitement: 3, type: 'parrot', word: 'b' })) as ToolSet;

      const say = async (set: ToolSet): Promise<unknown> => {
        const prepared = await set.prepare('say', { times: 1 });
        if (prepared.type !== 'immediate') throw new Error('unreachable');
        return await prepared.run({ abortSignal: new AbortController().signal });
      };
      expect(await say(quiet)).toEqual([{ text: 'a', type: 'text' }]);
      expect(await say(loud)).toEqual([{ text: 'b!!!', type: 'text' }]);
    } finally {
      await dispose();
    }
  });

  test('enforces a refinement in the child that the host cannot see', async () => {
    // `refine` has no JSON Schema notation, so the schema rebuilt here accepts
    // what the real one rejects. The check is not lost: the child validates
    // again before it builds anything, so the failure arrives when the instance
    // is created rather than never.
    const { contributions, dispose } = await activated();
    try {
      const parrot = configurable(contributions, 'parrot');
      expect(parrot.configSchema.safeParse({ type: 'parrot', word: 'forbidden' }).success).toBe(
        true,
      );
      const failure = await parrot
        .create({ type: 'parrot', word: 'forbidden' })
        .catch((error: unknown) => error as Error);
      expect((failure as Error).message).toContain('not repeatable');
    } finally {
      await dispose();
    }
  });

  test('gives the extension only the services it declared, and says so by name', async () => {
    const { dispose, host } = await activated();
    try {
      expect(await host.invoke('seen')).toEqual({
        logger: 'object',
        // Not "undefined", not a silent no-op: the refusal names the service,
        // because dropping the dependency and building the crossing both start
        // with knowing which one it was.
        undeclared: 'The service "nox.model-access" cannot cross into a confined extension yet.',
      });
    } finally {
      await dispose();
    }
  });

  test('refuses a contribution point that cannot cross, by name', async () => {
    // The cost of confining installed extensions, pinned where it happens.
    // Providers stream, which is its own crossing and not built — so a package
    // that contributes one is turned away when it activates rather than working
    // until the first model call.
    const host = new ExtensionProcess({
      allowances: [],
      extensionId: 'test.mimic',
      logger: silentLogger,
      runUnconfined: true,
    });
    try {
      await host.load(join(import.meta.dir, 'fixtures', 'mimic.ts'));
      const failure = await activateConfined(host, {
        ...manifest,
        id: 'test.mimic',
      }).catch((error: unknown) => error as Error);
      expect((failure as Error).message).toContain('nox.providers');
      expect((failure as Error).message).toContain('mimic_completions');
    } finally {
      await host.dispose();
    }
  });

  test('carries the extension’s own log line out of the process', async () => {
    const lines: { fields: Record<string, unknown>; message: string }[] = [];
    const { dispose } = await activated({
      ...silentLogger,
      info: (fields, message) => lines.push({ fields: { ...fields }, message }),
    });
    try {
      expect(lines).toMatchObject([
        {
          fields: { extensionId: 'test.parrot', from: 'activate', logger: 'test.parrot' },
          message: 'the parrot woke up',
        },
      ]);
    } finally {
      await dispose();
    }
  });
});
