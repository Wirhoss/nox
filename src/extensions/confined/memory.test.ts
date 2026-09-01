import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { silentLogger } from '../../logger/logger';
import { ExtensionProcess } from './host';
import { connectMemory } from './memory';

import type { Memory, MemoryScope } from '@nox/extension-api';

const NOTEBOOK = join(import.meta.dir, 'fixtures', 'notebook.ts');

const scope: MemoryScope = {
  agentId: 'analyst',
  principal: { issuer: 'test', subject: 'p-1' },
  sessionId: 's-1',
};

async function connected(factory: 'full' | 'sparse'): Promise<{
  dispose: () => Promise<void>;
  host: ExtensionProcess;
  memory: Memory;
}> {
  const host = new ExtensionProcess({
    allowances: [],
    extensionId: 'test.notebook',
    logger: silentLogger,
    runUnconfined: true,
  });
  await host.load(NOTEBOOK);
  await host.invoke('memory.bind', 'notebook-instance', factory);
  const memory = await connectMemory(host.scoped('notebook-instance'));
  return { dispose: () => host.dispose(), host, memory };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('connectMemory', () => {
  test('recalls and writes through the boundary', async () => {
    const { dispose, memory } = await connected('full');
    try {
      const written = await memory.editor?.write({
        kind: 'preference',
        scope,
        signal: signal(),
        text: 'prefers loud failures',
      });
      expect(written).toMatchObject({ kind: 'preference', text: 'prefers loud failures' });

      const recalled = await memory.recall({
        context: [],
        maxTokens: 100,
        query: 'loud',
        scope,
        signal: signal(),
      });
      expect(recalled.memories.map((entry) => entry.text)).toEqual(['prefers loud failures']);
    } finally {
      await dispose();
    }
  });

  test('carries Dates as Dates, not as the strings JSON would make of them', async () => {
    // `MemoryRetainRequest` has two of them. Sent plainly they arrive as ISO
    // strings — the same shape, the wrong type, and nothing to say so until
    // something calls a method on one. The far side is asked what it actually
    // received rather than being trusted to have received it.
    const { dispose, host, memory } = await connected('full');
    try {
      const startedAt = new Date('2026-08-31T10:00:00.000Z');
      await memory.retain({
        completedAt: new Date('2026-08-31T10:00:05.000Z'),
        messages: [],
        runId: 'run-1',
        scope,
        startedAt,
        status: 'completed',
        trigger: 'user',
      });

      expect(await host.invoke('retainedDateTypes')).toEqual(['Date,Date']);
      const received = (await host.invoke('lastRetained')) as { startedAt: Date };
      expect(received.startedAt.toISOString()).toBe(startedAt.toISOString());
    } finally {
      await dispose();
    }
  });

  test('reads and writes blocks', async () => {
    const { dispose, memory } = await connected('full');
    try {
      const read = await memory.blocks?.read({ labels: ['persona'], scope, signal: signal() });
      expect(read).toEqual([{ label: 'persona', value: 'block:persona' }]);

      const written = await memory.blocks?.write({
        label: 'persona',
        scope,
        signal: signal(),
        value: 'terse',
      });
      expect(written).toEqual({ label: 'persona', value: 'terse' });
    } finally {
      await dispose();
    }
  });

  test('reports the far side’s optional surfaces exactly', async () => {
    // Absence is meaningful: a memory with no editor cannot be granted Nox's
    // editing tools at all. A proxy that always looked complete would hand an
    // extension surfaces it never implemented, and the failure would land in
    // the middle of somebody's conversation instead of at connect time.
    const complete = await connected('full');
    const bare = await connected('sparse');
    try {
      expect(complete.memory.blocks).toBeDefined();
      expect(complete.memory.editor).toBeDefined();
      expect(complete.memory.inspector).toBeDefined();

      expect(bare.memory.blocks).toBeUndefined();
      expect(bare.memory.editor).toBeUndefined();
      expect(bare.memory.inspector).toBeUndefined();
      // Still a working memory, which is the whole point of the distinction.
      expect(
        (
          await bare.memory.recall({
            context: [],
            maxTokens: 10,
            query: 'anything',
            scope,
            signal: signal(),
          })
        ).memories,
      ).toEqual([]);
    } finally {
      await complete.dispose();
      await bare.dispose();
    }
  });

  test('refuses a surface the far side does not have', async () => {
    // Reached past the proxy on purpose: what the host would see if it called a
    // method the implementation never wrote.
    const { dispose, host } = await connected('sparse');
    try {
      const failure = await host
        .invoke('memory.editor.search', 'notebook-instance', { callId: 'c-1', query: 'x', scope })
        .catch((error: unknown) => error);
      expect((failure as Error).message).toContain('no editor');
    } finally {
      await dispose();
    }
  });

  test('inspects without an owner scope', async () => {
    const { dispose, memory } = await connected('full');
    try {
      expect(await memory.inspector?.scopes(signal())).toEqual([]);
      expect(
        await memory.inspector?.facts({ limit: 10, offset: 0, signal: signal() }),
      ).toMatchObject({ entries: [], limit: 10, offset: 0 });
    } finally {
      await dispose();
    }
  });
});
