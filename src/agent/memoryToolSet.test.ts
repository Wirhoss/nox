import { prepareToolCall } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

import { AuthorityCatalog } from '../auth/authority';
import { CORE_AUTHORITIES } from '../auth/coreAuthorities';
import { MemoryToolSet, memoryToolSetGrant } from './memoryToolSet';
import { snapshotToolSets } from './tools';

import type {
  MemoryEditor,
  MemoryForgetRequest,
  MemorySearchRequest,
  MemoryUpdateRequest,
  MemoryWriteRequest,
} from '@nox/extension-api';

const PRINCIPAL = Object.freeze({ issuer: 'web', subject: 'alice' });

interface Calls {
  forget?: MemoryForgetRequest;
  search?: MemorySearchRequest;
  update?: MemoryUpdateRequest;
  write?: MemoryWriteRequest;
}

function fakeEditor(calls: Calls = {}): MemoryEditor {
  return {
    forget: (request) => {
      calls.forget = request;
      return true;
    },
    search: (request) => {
      calls.search = request;
      return [
        {
          id: '7',
          kind: 'preference',
          text: 'Alice prefers jasmine tea.',
          validFrom: '2026-01-01T00:00:00.000Z',
        },
      ];
    },
    update: (request) => {
      calls.update = request;
      return { id: '8', kind: request.kind, text: request.text };
    },
    write: (request) => {
      calls.write = request;
      return { id: '7', kind: request.kind, text: request.text };
    },
  };
}

function context() {
  return {
    abortSignal: new AbortController().signal,
    session: {
      agentId: 'agent-a',
      metadata: Object.freeze({ conversationId: 'conversation-1' }),
      principal: PRINCIPAL,
      sessionId: 'session-1',
    },
    toolSetId: 'nox.memory',
  };
}

async function run(toolSet: MemoryToolSet, name: string, params: unknown) {
  const tool = toolSet.tools[name];
  if (tool === undefined) throw new Error(`Memory tool ${name} is not registered.`);
  const prepared = await prepareToolCall(tool, params);
  if (prepared.type !== 'immediate') throw new Error('Expected an immediate memory tool.');
  return prepared.run(context());
}

describe('MemoryToolSet', () => {
  test('searches under the immutable agent, principal, session, and metadata scope', async () => {
    const calls: Calls = {};
    const tools = new MemoryToolSet(fakeEditor(calls));

    const output = await run(tools, 'memory_search', { query: 'tea' });

    expect(calls.search).toMatchObject({
      limit: 5,
      query: 'tea',
      scope: {
        agentId: 'agent-a',
        metadata: { conversationId: 'conversation-1' },
        principal: PRINCIPAL,
        sessionId: 'session-1',
      },
    });
    expect(JSON.parse(output[0]?.type === 'text' ? output[0].text : '')).toMatchObject({
      count: 1,
      memories: [{ id: '7', kind: 'preference' }],
    });
  });

  /**
   * A free-text kind produced facts under categories nothing else recognised —
   * and consolidation, which only compares facts of one kind, then refused to
   * merge them with the extracted statement of the same claim.
   */
  test('refuses a kind outside the vocabulary the extractor shares', () => {
    const tools = new MemoryToolSet(fakeEditor({}));
    const write = tools.tools.memory_write;
    if (write === undefined) throw new Error('memory_write is not registered.');

    expect(
      prepareToolCall(write, { kind: 'plan', text: 'Alice will do the QA.' }),
    ).rejects.toThrow();
    expect(
      prepareToolCall(write, { kind: 'preference', text: 'Alice prefers jasmine tea.' }),
    ).resolves.toBeDefined();
  });

  test('writes, replaces, and retires opaque fact IDs through the editor only', async () => {
    const calls: Calls = {};
    const tools = new MemoryToolSet(fakeEditor(calls));

    await run(tools, 'memory_write', {
      kind: 'preference',
      text: 'Alice prefers jasmine tea.',
    });
    const update = await run(tools, 'memory_update', {
      id: '7',
      kind: 'preference',
      text: 'Alice prefers oolong tea.',
      validFrom: '2026-04-01T10:00:00+00:00',
    });
    const forgotten = await run(tools, 'memory_forget', { id: '8' });

    expect(calls.write?.scope.principal).toEqual(PRINCIPAL);
    expect(calls.update).toMatchObject({
      id: '7',
      kind: 'preference',
      text: 'Alice prefers oolong tea.',
      validFrom: '2026-04-01T10:00:00+00:00',
    });
    expect(calls.forget).toMatchObject({ id: '8', scope: { principal: PRINCIPAL } });
    expect(JSON.parse(update[0]?.type === 'text' ? update[0].text : '')).toMatchObject({
      id: '7',
      updated: true,
    });
    expect(JSON.parse(forgotten[0]?.type === 'text' ? forgotten[0].text : '')).toEqual({
      forgotten: true,
      id: '8',
    });
  });

  test('exposes only the memory tools explicitly allowlisted by the blueprint grant', () => {
    const grant = memoryToolSetGrant(fakeEditor(), ['memory_search']);
    const visible = snapshotToolSets([grant], 'direct', AuthorityCatalog.from(CORE_AUTHORITIES));

    expect(Object.keys(grant.toolSet.tools)).toEqual([
      'memory_forget',
      'memory_search',
      'memory_update',
      'memory_write',
    ]);
    expect(Object.keys(visible)).toEqual(['memory_search']);
    expect(visible.memory_search?.declaration.authority).toBe('nox.core.memory.read');
  });

  test('refuses execution without a host session instead of inventing a memory owner', async () => {
    const tools = new MemoryToolSet(fakeEditor());
    const search = tools.tools.memory_search;
    if (search === undefined) throw new Error('Memory search tool is not registered.');
    const prepared = await prepareToolCall(search, { query: 'tea' });
    if (prepared.type !== 'immediate') throw new Error('Expected an immediate memory tool.');

    const execution = prepared.run({
      abortSignal: new AbortController().signal,
      toolSetId: 'nox.memory',
    });
    expect(execution).rejects.toThrow('require an active agent session');
  });
});
