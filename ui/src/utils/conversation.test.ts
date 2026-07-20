import { describe, expect, test } from 'bun:test';

import { actionState, agentTime, buildAgentBlocks, buildConversation } from './conversation';

import type { Message } from './types';

const user = (text: string): Message => ({ content: [{ text, type: 'text' }], role: 'user' });
const assistant = (text: string): Message => ({ content: [{ text, type: 'text' }], role: 'assistant' });
const reasoning = (text: string): Message => ({ content: [{ text, type: 'text' }], role: 'reasoning' });
const toolCall = (name: string, trackId: string): Message => ({ arguments: {}, name, role: 'toolCall', trackId });
const toolResponse = (
  name: string,
  trackId: string,
  overrides: Partial<Extract<Message, { role: 'toolResponse' }>> = {},
): Message => ({
  execution: 'immediate',
  name,
  response: [{ text: 'ok', type: 'text' }],
  role: 'toolResponse',
  trackId,
  ...overrides,
});

const noTimes = (count: number): Array<Date | null> => Array.from({ length: count }, () => null);

describe('buildConversation', () => {
  test('collapses consecutive agent output into a single turn', () => {
    const messages = [user('hi'), reasoning('thinking'), toolCall('read', 't1'), toolResponse('read', 't1'), assistant('done')];

    const items = buildConversation(messages, noTimes(messages.length), false);

    expect(items).toHaveLength(2);
    expect(items[0]?.kind).toBe('user');
    expect(items[1]?.kind).toBe('agent');
    expect(items[1]?.kind === 'agent' && items[1].entries).toHaveLength(4);
  });

  test('starts a new turn on every user message', () => {
    const messages = [user('one'), assistant('a'), user('two'), assistant('b')];

    const items = buildConversation(messages, noTimes(messages.length), false);

    expect(items.map((item) => item.kind)).toEqual(['user', 'agent', 'user', 'agent']);
  });

  test('marks the trailing agent turn as live', () => {
    const messages = [user('hi'), assistant('partial')];

    const items = buildConversation(messages, noTimes(messages.length), true);

    expect(items[1]?.kind === 'agent' && items[1].live).toBe(true);
  });

  test('opens an empty agent turn when a run streams before any message settles', () => {
    const messages = [user('hi')];

    const items = buildConversation(messages, noTimes(messages.length), true);

    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({ entries: [], kind: 'agent', live: true });
  });

  test('pairs each message with its timestamp and tolerates a short times array', () => {
    const messages = [user('hi'), assistant('yo')];
    const when = new Date('2026-07-20T10:00:00Z');

    const items = buildConversation(messages, [when], false);

    expect(items[0]?.kind === 'user' && items[0].entry.time).toBe(when);
    expect(items[1]?.kind === 'agent' && items[1].entries[0]?.time).toBeNull();
  });
});

describe('buildAgentBlocks', () => {
  test('merges a call and its response into one action, keeping its position', () => {
    const entries = [
      { message: reasoning('think'), time: null },
      { message: toolCall('read', 't1'), time: null },
      { message: assistant('answer'), time: null },
      { message: toolResponse('read', 't1'), time: null },
    ];

    const blocks = buildAgentBlocks(entries);

    // The response folds into the action created at index 1, rather than
    // appending a fourth block after the assistant prose.
    expect(blocks.map((block) => block.kind)).toEqual(['reasoning', 'tools', 'assistant']);
    const tools = blocks[1];
    expect(tools?.kind === 'tools' && tools.actions[0]?.call).toBeDefined();
    expect(tools?.kind === 'tools' && tools.actions[0]?.responses).toHaveLength(1);
  });

  test('batches back-to-back tools into one block', () => {
    const entries = [
      { message: reasoning('plan'), time: null },
      { message: toolCall('read', 't1'), time: null },
      { message: toolCall('write', 't2'), time: null },
      { message: toolResponse('read', 't1'), time: null },
      { message: toolResponse('write', 't2'), time: null },
      { message: assistant('done'), time: null },
    ];

    const blocks = buildAgentBlocks(entries);

    expect(blocks.map((block) => block.kind)).toEqual(['reasoning', 'tools', 'assistant']);
    const tools = blocks[1];
    expect(tools?.kind === 'tools' && tools.actions.map((action) => action.trackId)).toEqual(['t1', 't2']);
  });

  test('splits tool blocks when the agent speaks between them', () => {
    const entries = [
      { message: toolCall('read', 't1'), time: null },
      { message: assistant('found it'), time: null },
      { message: toolCall('write', 't2'), time: null },
    ];

    const blocks = buildAgentBlocks(entries);

    expect(blocks.map((block) => block.kind)).toEqual(['tools', 'assistant', 'tools']);
    expect(blocks[0]?.kind === 'tools' && blocks[0].actions).toHaveLength(1);
    expect(blocks[2]?.kind === 'tools' && blocks[2].actions).toHaveLength(1);
  });

  test('a late response never re-opens a closed block', () => {
    const entries = [
      { message: toolCall('slow', 't1'), time: null },
      { message: assistant('meanwhile'), time: null },
      { message: toolCall('fast', 't2'), time: null },
      { message: toolResponse('slow', 't1'), time: null },
    ];

    const blocks = buildAgentBlocks(entries);

    // The `slow` result belongs to the first block, not the one currently open.
    expect(blocks.map((block) => block.kind)).toEqual(['tools', 'assistant', 'tools']);
    expect(blocks[0]?.kind === 'tools' && blocks[0].actions[0]?.responses).toHaveLength(1);
    expect(blocks[2]?.kind === 'tools' && blocks[2].actions[0]?.responses).toHaveLength(0);
  });

  test('collects repeated responses from a deferred tool', () => {
    const entries = [
      { message: toolCall('deploy', 't1'), time: null },
      { message: toolResponse('deploy', 't1', { execution: 'deferredAck' }), time: null },
      { message: toolResponse('deploy', 't1', { execution: 'deferredResult' }), time: null },
    ];

    const blocks = buildAgentBlocks(entries);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind === 'tools' && blocks[0].actions[0]?.responses).toHaveLength(2);
  });

  test('carries the time of the action\'s most recent message', () => {
    const first = new Date('2026-07-20T10:00:00Z');
    const last = new Date('2026-07-20T10:00:05Z');
    const entries = [
      { message: toolCall('read', 't1'), time: first },
      { message: toolResponse('read', 't1'), time: last },
    ];

    const blocks = buildAgentBlocks(entries);

    expect(blocks[0]?.kind === 'tools' && blocks[0].actions[0]?.time).toBe(last);
  });
});

describe('actionState', () => {
  const action = (responses: Array<Extract<Message, { role: 'toolResponse' }>>): Parameters<typeof actionState>[0] =>
    ({ name: 'read', responses, time: null, trackId: 't1' });

  test('reports a call with no response as running', () => {
    expect(actionState(action([]))).toBe('Running');
  });

  test('reports the latest response, so a deferred result supersedes its ack', () => {
    const ack = toolResponse('read', 't1', { execution: 'deferredAck' }) as Extract<Message, { role: 'toolResponse' }>;
    const result = toolResponse('read', 't1', { execution: 'deferredResult' }) as Extract<Message, { role: 'toolResponse' }>;

    expect(actionState(action([ack]))).toBe('Accepted');
    expect(actionState(action([ack, result]))).toBe('Completed');
  });

  test('reports failure regardless of execution kind', () => {
    const failure = toolResponse('read', 't1', { isError: true }) as Extract<Message, { role: 'toolResponse' }>;

    expect(actionState(action([failure]))).toBe('Failed');
  });
});

describe('agentTime', () => {
  const fallback = new Date('2026-07-20T09:00:00Z');

  test('prefers the last assistant message', () => {
    const answered = new Date('2026-07-20T10:00:00Z');
    const entries = [
      { message: assistant('first'), time: new Date('2026-07-20T09:30:00Z') },
      { message: assistant('second'), time: answered },
      { message: toolResponse('read', 't1'), time: new Date('2026-07-20T10:05:00Z') },
    ];

    expect(agentTime(entries, fallback)).toBe(answered);
  });

  test('falls back to the last entry when the turn produced no prose', () => {
    const called = new Date('2026-07-20T10:00:00Z');

    expect(agentTime([{ message: toolCall('read', 't1'), time: called }], fallback)).toBe(called);
  });

  test('falls back to the run start for an empty or untimed turn', () => {
    expect(agentTime([], fallback)).toBe(fallback);
    expect(agentTime([{ message: assistant('a'), time: null }], fallback)).toBe(fallback);
  });
});
