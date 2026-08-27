import { describe, expect, test } from 'bun:test';

import { testOrigin } from '../../testFixtures';
import { applyCompaction, seekSafeCut } from './compact';
import { freezeMessage } from './immutable';

import type { CompactedMessage, Message } from '@nox/extension-api';

const CREATED_AT = new Date('2025-01-01T00:00:00.000Z');

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected test value to exist.');
  return value;
}

function text(role: 'assistant' | 'user', messageId: string): Message {
  if (role === 'user') {
    return freezeMessage({
      content: [{ text: messageId, type: 'text' }],
      createdAt: CREATED_AT,
      messageId,
      origin: testOrigin(),
      role,
    });
  }
  return freezeMessage({
    content: [{ text: messageId, type: 'text' }],
    createdAt: CREATED_AT,
    messageId,
    role,
  });
}

function toolCall(messageId: string, trackId: string): Message {
  return freezeMessage({
    arguments: {},
    createdAt: CREATED_AT,
    messageId,
    name: 'tool',
    role: 'toolCall',
    trackId,
  });
}

function toolResponse(messageId: string, trackId: string): Message {
  return freezeMessage({
    createdAt: CREATED_AT,
    execution: 'immediate',
    messageId,
    name: 'tool',
    response: [],
    role: 'toolResponse',
    trackId,
    trust: 'untrusted',
  });
}

function compaction(overrides: Partial<CompactedMessage> = {}): CompactedMessage {
  return freezeMessage({
    compactedMessageIds: ['m2', 'm3'],
    content: [{ text: 'summary', type: 'text' }],
    createdAt: CREATED_AT,
    messageId: 'compact',
    role: 'compacted',
    ...overrides,
  });
}

describe('safe compaction cuts', () => {
  const history = [
    text('user', 'u'),
    toolCall('call', 'track'),
    toolResponse('response', 'track'),
    text('assistant', 'a'),
  ];

  test('never cuts between a tool call and its response', () => {
    expect(seekSafeCut(history, 2, 1)).toBe(3);
    expect(seekSafeCut(history, 2, -1)).toBe(1);
  });

  test('leaves already-safe and out-of-range cuts bounded', () => {
    expect(seekSafeCut(history, 1, 1)).toBe(1);
    expect(seekSafeCut(history, 3, -1)).toBe(3);
    expect(seekSafeCut(history, -100, 1)).toBe(0);
    expect(seekSafeCut(history, 100, -1)).toBe(history.length);
  });
});

describe('applyCompaction invariants', () => {
  const history = [
    text('user', 'm1'),
    text('assistant', 'm2'),
    text('user', 'm3'),
    text('assistant', 'm4'),
  ];

  test('replaces one contiguous range and preserves unaffected references', () => {
    const event = compaction();
    const result = applyCompaction(history, event);
    expect(result).toEqual([requireValue(history[0]), event, requireValue(history[3])]);
    expect(result[0]).toBe(history[0]);
    expect(result[2]).toBe(history[3]);
  });

  test('the reference order does not affect deterministic placement', () => {
    const event = compaction({ compactedMessageIds: ['m3', 'm2'] });
    expect(applyCompaction(history, event)).toEqual([
      requireValue(history[0]),
      event,
      requireValue(history[3]),
    ]);
  });

  test('rejects empty, duplicate and self references', () => {
    expect(() => applyCompaction(history, compaction({ compactedMessageIds: [] }))).toThrow(
      'does not replace any messages',
    );
    expect(() =>
      applyCompaction(history, compaction({ compactedMessageIds: ['m2', 'm2'] })),
    ).toThrow('duplicate message references');
    expect(() =>
      applyCompaction(history, compaction({ compactedMessageIds: ['compact'] })),
    ).toThrow('cannot replace itself');
  });

  test('rejects missing and non-contiguous ranges', () => {
    expect(() =>
      applyCompaction(history, compaction({ compactedMessageIds: ['m2', 'missing'] })),
    ).toThrow('references missing messages: missing');
    expect(() =>
      applyCompaction(history, compaction({ compactedMessageIds: ['m1', 'm3'] })),
    ).toThrow('non-contiguous message range');
  });
});
