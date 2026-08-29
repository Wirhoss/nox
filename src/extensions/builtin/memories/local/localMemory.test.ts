import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { Database } from '../../../../database/database';
import { extensionState } from '../../../../database/schema';
import { DatabaseExtensionStorageProvider, MemoryExtensionStorageProvider } from '../../../storage';
import { LocalMemory } from './localMemory';

import type { MemoryRecallRequest, MemoryRetainRequest, PrincipalRef } from '@nox/extension-api';

const ALICE = { issuer: 'web', subject: 'alice' } as const;

function memory(
  provider: MemoryExtensionStorageProvider,
  config: { maxEntriesPerScope?: number; maxRecallItems?: number } = {},
): LocalMemory {
  const parsed = LocalMemory.configSchema.parse({ ...config, type: 'local' });
  return new LocalMemory(provider.forExtension('nox.memory.local'), parsed);
}

function retainRequest(
  agentId: string,
  principal: PrincipalRef,
  runId: string,
  text: string,
  minute: number,
): MemoryRetainRequest {
  const startedAt = new Date(Date.UTC(2026, 0, 2, 3, minute, 0));
  return {
    completedAt: new Date(startedAt.getTime() + 1_000),
    messages: [
      {
        createdAt: startedAt,
        messageId: `${runId}-user`,
        principal,
        role: 'user',
        text,
      },
      {
        createdAt: new Date(startedAt.getTime() + 500),
        messageId: `${runId}-assistant`,
        role: 'assistant',
        text: `Stored ${runId}.`,
      },
    ],
    runId,
    scope: { agentId, principal, sessionId: `session-${runId}` },
    startedAt,
    status: 'completed',
    trigger: 'user',
  };
}

function recallRequest(
  agentId: string,
  principal: PrincipalRef,
  query: string,
  maxTokens = 500,
): MemoryRecallRequest {
  return {
    context: [],
    maxTokens,
    query,
    scope: { agentId, principal, sessionId: 'current-session' },
    signal: new AbortController().signal,
  };
}

describe('LocalMemory', () => {
  test('recalls across sessions without crossing agent or principal SQL scopes', async () => {
    const storage = new MemoryExtensionStorageProvider();
    const local = memory(storage);

    await local.retain(retainRequest('agent-a', ALICE, 'tea', 'I prefer jasmine tea.', 1));
    await local.retain(retainRequest('agent-b', ALICE, 'coffee', 'I prefer dark coffee.', 2));
    await local.retain(
      retainRequest('agent-a', { issuer: 'web', subject: 'bob' }, 'ramen', 'I like ramen.', 3),
    );

    const alice = await local.recall(recallRequest('agent-a', ALICE, 'Which jasmine tea?'));
    const wrongAgent = await local.recall(recallRequest('agent-b', ALICE, 'jasmine tea'));
    const wrongPrincipal = await local.recall(
      recallRequest('agent-a', { issuer: 'web', subject: 'bob' }, 'jasmine tea'),
    );

    expect(alice.memories).toHaveLength(1);
    expect(alice.memories[0]).toMatchObject({
      id: 'tea',
      metadata: { sessionId: 'session-tea' },
    });
    expect(alice.memories[0]?.text).toContain('I prefer jasmine tea.');
    expect(wrongAgent.memories).toEqual([]);
    expect(wrongPrincipal.memories).toEqual([]);
  });

  test('persists through Nox SQLite and survives reopening the database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nox-local-memory-'));
    const path = join(directory, 'nox.db');
    let database = await Database.open({ path });

    try {
      const writer = new LocalMemory(
        new DatabaseExtensionStorageProvider(database).forExtension('nox.memory.local'),
        LocalMemory.configSchema.parse({ type: 'local' }),
      );
      await writer.retain(
        retainRequest('agent-a', ALICE, 'sql-persistent', 'My project is called Nox.', 1),
      );
      expect(database.db.select().from(extensionState).all()).toHaveLength(1);

      await database.close();
      database = await Database.open({ path });
      const reader = new LocalMemory(
        new DatabaseExtensionStorageProvider(database).forExtension('nox.memory.local'),
        LocalMemory.configSchema.parse({ type: 'local' }),
      );
      const result = await reader.recall(recallRequest('agent-a', ALICE, 'project Nox'));

      expect(result.memories.map(({ id }) => id)).toEqual(['sql-persistent']);
    } finally {
      await database.close();
      await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    }
  });

  test('persists through another engine instance backed by the same Nox storage', async () => {
    const storage = new MemoryExtensionStorageProvider();
    await memory(storage).retain(
      retainRequest('agent-a', ALICE, 'persistent', 'My project is called Nox.', 1),
    );

    const reopened = memory(storage);
    const result = await reopened.recall(recallRequest('agent-a', ALICE, 'project Nox'));

    expect(result.memories.map(({ id }) => id)).toEqual(['persistent']);
  });

  test('prunes the oldest entries per isolated scope', async () => {
    const storage = new MemoryExtensionStorageProvider();
    const local = memory(storage, { maxEntriesPerScope: 2, maxRecallItems: 10 });

    await local.retain(retainRequest('agent-a', ALICE, 'first', 'Shared keyword first.', 1));
    await local.retain(retainRequest('agent-a', ALICE, 'second', 'Shared keyword second.', 2));
    await local.retain(retainRequest('agent-a', ALICE, 'third', 'Shared keyword third.', 3));

    const result = await local.recall(recallRequest('agent-a', ALICE, 'shared keyword'));

    expect(result.memories.map(({ id }) => id)).toEqual(['third', 'second']);
  });

  test('attributes a remembered line to the person who said it', async () => {
    const storage = new MemoryExtensionStorageProvider();
    const local = memory(storage);
    const request = retainRequest('agent-a', ALICE, 'name', 'Yo soy Wirhoss.', 1);

    await local.retain({
      ...request,
      messages: request.messages.map((entry) =>
        entry.role === 'user' ? { ...entry, displayName: 'Wirhoss' } : entry,
      ),
    });
    const result = await local.recall(recallRequest('agent-a', ALICE, 'Wirhoss'));

    expect(result.memories[0]?.text).toContain('User (Wirhoss <web:alice>): Yo soy Wirhoss.');
    expect(result.memories[0]?.text).toContain('Assistant: Stored name.');
  });

  test('renders the principal alone when the transport never had a name', async () => {
    const storage = new MemoryExtensionStorageProvider();
    const local = memory(storage);

    await local.retain(retainRequest('agent-a', ALICE, 'anon', 'Yo soy alguien.', 1));
    const result = await local.recall(recallRequest('agent-a', ALICE, 'alguien'));

    expect(result.memories[0]?.text).toContain('User (web:alice): Yo soy alguien.');
  });

  test('bounds its own recalled payload before the runner applies its final guard', async () => {
    const storage = new MemoryExtensionStorageProvider();
    const local = memory(storage);
    await local.retain(
      retainRequest('agent-a', ALICE, 'large', `jasmine ${'tea '.repeat(200)}`, 1),
    );

    const result = await local.recall(recallRequest('agent-a', ALICE, 'jasmine tea', 20));

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]?.text.length).toBeLessThanOrEqual(60);
    expect(result.memories[0]?.metadata).toMatchObject({ truncated: true });
  });
});
