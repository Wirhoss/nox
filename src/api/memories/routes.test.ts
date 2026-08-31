import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { Database } from '../../database/database';
import { silentLogger } from '../../logger/logger';
import { RegistrationWindow } from '../auth/registration';
import { AuthStore } from '../auth/store';
import { ApiServer } from '../server';

import type { MemoryRuntime } from '../../runtime/configurationRuntime';
import type { Memory, MemoryInspectionQuery, MemoryScope } from '@nox/extension-api';

const databases: Database[] = [];
const directories: string[] = [];
const servers: ApiServer[] = [];
const PASSWORD = 'correct-horse-battery';
const ALICE = { issuer: 'discord', subject: 'alice' } as const;

interface Calls {
  readonly inspections: MemoryInspectionQuery[];
  mutationScope?: MemoryScope;
}

async function memoryNox(calls: Calls) {
  const directory = await mkdtemp(join(tmpdir(), 'nox-memories-'));
  directories.push(directory);
  const database = await Database.open({ logger: silentLogger, path: join(directory, 'nox.db') });
  databases.push(database);
  const auth = await AuthStore.open({ database, dataDirectory: directory, logger: silentLogger });
  const account = await auth.register('wirhoss', PASSWORD);
  const tokens = await auth.openSession(account.accountId);

  const memory: Memory = {
    editor: {
      forget: (request) => {
        calls.mutationScope = request.scope;
        return request.scope.principal.subject === ALICE.subject;
      },
      search: () => [],
      update: (request) => {
        calls.mutationScope = request.scope;
        return request.scope.principal.subject === ALICE.subject
          ? { id: '2', kind: request.kind, text: request.text }
          : undefined;
      },
      write: (request) => {
        calls.mutationScope = request.scope;
        return { id: '2', kind: request.kind, text: request.text };
      },
    },
    inspector: {
      episodes: (request) => {
        calls.inspections.push(request);
        return {
          entries: [
            {
              completedAt: '2026-08-29T10:00:00.000Z',
              episodeId: '3',
              factIds: ['1'],
              runId: 'run-1',
              scope: { agentId: 'nox', principal: ALICE },
              sessionId: 'conversation-1',
              startedAt: '2026-08-29T09:59:00.000Z',
              status: 'completed',
              transcript: 'User: I prefer tea.',
              trigger: 'user',
            },
          ],
          limit: request.limit,
          offset: request.offset,
          total: 1,
        };
      },
      facts: (request) => {
        calls.inspections.push(request);
        return {
          entries: [
            {
              accessCount: 4,
              confidence: 0.9,
              createdAt: '2026-08-29T10:01:00.000Z',
              id: '1',
              kind: 'preference',
              lastAccessedAt: '2026-08-29T11:00:00.000Z',
              provenance: [
                {
                  completedAt: '2026-08-29T10:00:00.000Z',
                  episodeId: '3',
                  sessionId: 'conversation-1',
                  trigger: 'user',
                },
              ],
              supportCount: 1,
              text: 'Alice prefers tea.',
              validFrom: '2026-08-29T10:00:00.000Z',
            },
          ],
          limit: request.limit,
          offset: request.offset,
          total: 1,
        };
      },
      scopes: () => [
        {
          accessCount: 4,
          agentId: 'nox',
          episodeCount: 1,
          factCount: 1,
          liveFactCount: 1,
          principal: ALICE,
        },
      ],
    },
    recall: () => ({ memories: [] }),
    retain: () => undefined,
  };
  const memories: MemoryRuntime = {
    memory: (memoryId) => (memoryId === 'semantic' ? memory : undefined),
    memoryInventory: () => [{ editable: true, id: 'semantic', inspectable: true }],
  };
  const server = ApiServer.create({
    auth: { registration: RegistrationWindow.closed(), store: auth },
    host: '127.0.0.1',
    logger: silentLogger,
    memories,
    port: 0,
  });
  await server.listen();
  servers.push(server);
  return {
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      'content-type': 'application/json',
    },
    url: `${server.url}/api`,
  };
}

function scopeQuery(): string {
  return new URLSearchParams({
    agentId: 'nox',
    issuer: ALICE.issuer,
    subject: ALICE.subject,
  }).toString();
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(
    // Swallowed like every other temp directory in the suite: on Windows the
    // database file can still be held for a moment after it is closed, and a
    // directory the OS has not let go of yet is not a failing test.
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }).catch(() => undefined)),
  );
});

describe('memory audit routes', () => {
  test('require the installation owner and enumerate active memory capabilities', async () => {
    const nox = await memoryNox({ inspections: [] });

    expect((await fetch(`${nox.url}/memories`)).status).toBe(401);
    const response = await fetch(`${nox.url}/memories`, { headers: nox.headers });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      memories: [{ editable: true, id: 'semantic', inspectable: true }],
    });
  });

  test('projects scopes, facts, episodes, provenance, invalidations, and access metadata', async () => {
    const calls: Calls = { inspections: [] };
    const nox = await memoryNox(calls);

    const scopes = await fetch(`${nox.url}/memories/semantic/scopes`, { headers: nox.headers });
    const facts = await fetch(`${nox.url}/memories/semantic/facts?${scopeQuery()}`, {
      headers: nox.headers,
    });
    const episodes = await fetch(`${nox.url}/memories/semantic/episodes?${scopeQuery()}`, {
      headers: nox.headers,
    });

    expect(await scopes.json()).toMatchObject({ scopes: [{ principal: ALICE }] });
    expect(await facts.json()).toMatchObject({
      entries: [{ accessCount: 4, id: '1', provenance: [{ episodeId: '3' }] }],
      total: 1,
    });
    expect(await episodes.json()).toMatchObject({
      entries: [{ episodeId: '3', factIds: ['1'], transcript: 'User: I prefer tea.' }],
      total: 1,
    });
    expect(calls.inspections.map(({ scope }) => scope)).toEqual([
      { agentId: 'nox', principal: ALICE },
      { agentId: 'nox', principal: ALICE },
    ]);
  });

  test('writes, corrects, and retires only the explicit audited owner scope', async () => {
    const calls: Calls = { inspections: [] };
    const nox = await memoryNox(calls);
    const body = JSON.stringify({
      agentId: 'nox',
      issuer: ALICE.issuer,
      kind: 'preference',
      subject: ALICE.subject,
      text: 'Alice prefers oolong tea.',
    });

    const written = await fetch(`${nox.url}/memories/semantic/facts`, {
      body,
      headers: nox.headers,
      method: 'POST',
    });
    const updated = await fetch(`${nox.url}/memories/semantic/facts/1`, {
      body,
      headers: nox.headers,
      method: 'PUT',
    });
    const forgotten = await fetch(`${nox.url}/memories/semantic/facts/2?${scopeQuery()}`, {
      headers: nox.headers,
      method: 'DELETE',
    });

    expect(written.status).toBe(201);
    expect(updated.status).toBe(200);
    expect(forgotten.status).toBe(204);
    expect(calls.mutationScope).toMatchObject({ agentId: 'nox', principal: ALICE });
    // Asserted apart from the shape so the matcher's `any` does not widen it.
    expect(calls.mutationScope?.sessionId).toContain('nox.memory.audit:');
  });
});
