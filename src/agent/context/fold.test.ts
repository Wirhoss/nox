import { describe, expect, test } from 'bun:test';

import { testOrigin } from '../../testFixtures';
import { applyFold, foldHistory } from './fold';
import { freezeMessage } from './immutable';
import { type FoldedMessage, type Message, messageToString } from './message';

const CREATED_AT = new Date('2025-01-01T00:00:00.000Z');

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected test value to exist.');
  return value;
}

function assistant(messageId: string, text = 'assistant'): Message {
  return freezeMessage({
    content: [{ text, type: 'text' }],
    createdAt: CREATED_AT,
    messageId,
    role: 'assistant',
  });
}

function emptyAssistant(messageId: string): Message {
  return freezeMessage({
    content: [],
    createdAt: CREATED_AT,
    messageId,
    role: 'assistant',
  });
}

function reasoning(messageId: string, text = 'reasoning'): Message {
  return freezeMessage({
    content: [{ text, type: 'text' }],
    createdAt: CREATED_AT,
    messageId,
    role: 'reasoning',
  });
}

function user(messageId: string, text = 'user'): Message {
  return freezeMessage({
    content: [{ text, type: 'text' }],
    createdAt: CREATED_AT,
    messageId,
    origin: testOrigin(),
    role: 'user',
  });
}

function call(messageId: string, trackId: string, size = 2000): Message {
  return freezeMessage({
    arguments: { payload: 'x'.repeat(size) },
    createdAt: CREATED_AT,
    messageId,
    name: 'tool',
    role: 'toolCall',
    trackId,
  });
}

function response(messageId: string, trackId: string, size = 2000): Message {
  return freezeMessage({
    createdAt: CREATED_AT,
    execution: 'immediate',
    messageId,
    name: 'tool',
    response: [{ text: 'y'.repeat(size), type: 'text' }],
    role: 'toolResponse',
    trackId,
    trust: 'untrusted',
  });
}

function foldEvent(overrides: Partial<FoldedMessage> = {}): FoldedMessage {
  return freezeMessage({
    anchorMessageId: 'anchor',
    content: [{ text: 'fold', type: 'text' }],
    createdAt: CREATED_AT,
    foldedMessageIds: ['call', 'response'],
    messageId: 'fold',
    role: 'folded',
    ...overrides,
  });
}

const estimateByRenderedLength = (message: Message): number => messageToString(message).length;

describe('foldHistory', () => {
  test('replaces only mechanical messages and preserves every unaffected object and byte', () => {
    const history = [
      assistant('anchor'),
      call('call', 'track'),
      response('response', 'track'),
      assistant('after'),
      user('suffix'),
    ];
    const unaffectedBytes = [
      messageToString(requireValue(history[0])),
      ...history.slice(3).map(messageToString),
    ];

    const result = foldHistory(history, {
      estimateTokens: estimateByRenderedLength,
      fromMessageId: 'call',
      minReductionRatio: 0.1,
      toMessageId: 'response',
    });

    expect(result.events).toHaveLength(1);
    expect(result.history.map((message) => message.role)).toEqual([
      'assistant',
      'folded',
      'assistant',
      'user',
    ]);
    expect(result.history[0]).toBe(history[0]);
    expect(result.history[2]).toBe(history[3]);
    expect(result.history[3]).toBe(history[4]);
    expect([
      messageToString(requireValue(result.history[0])),
      ...result.history.slice(2).map(messageToString),
    ]).toEqual(unaffectedBytes);
    expect(result.events[0]?.foldedMessageIds).toEqual(['call', 'response']);
  });

  test('keeps one fold across reasoning and synthetic anchors between tool calls', () => {
    const history = [
      emptyAssistant('anchor'),
      call('call-1', 'track-1'),
      response('response-1', 'track-1'),
      reasoning('reasoning-between', 'inspect the first result'),
      emptyAssistant('synthetic-anchor'),
      call('call-2', 'track-2'),
      response('response-2', 'track-2'),
      reasoning('final-reasoning', 'compose the answer'),
      assistant('answer'),
    ];

    const result = foldHistory(history, {
      estimateTokens: estimateByRenderedLength,
      minReductionRatio: 0.01,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.anchorMessageId).toBe('anchor');
    expect(result.events[0]?.foldedMessageIds).toEqual([
      'call-1',
      'response-1',
      'synthetic-anchor',
      'call-2',
      'response-2',
    ]);
    const foldedContent = result.events[0]?.content[0];
    expect(foldedContent?.type).toBe('text');
    if (foldedContent?.type !== 'text') throw new Error('Expected folded text content.');
    expect([...foldedContent.text.matchAll(/\n---\n/g)]).toHaveLength(1);
    expect(foldedContent.text).toContain('Outcome: ok\n---\nTool Name: tool');
    expect(foldedContent.text.includes('-----Folded tool calls-----\n---\n')).toBeFalse();
    expect(foldedContent.text.endsWith('\n---')).toBeFalse();
    expect(result.history.map((message) => message.messageId)).toEqual([
      'anchor',
      requireValue(result.events[0]).messageId,
      'reasoning-between',
      'final-reasoning',
      'answer',
    ]);
    expect(result.history[2]).toBe(history[3]);
    expect(result.history[3]).toBe(history[7]);
  });

  test("does not consume the next loop's anchor when the range ends before its call", () => {
    const history = [
      emptyAssistant('anchor'),
      call('call-1', 'track-1'),
      response('response-1', 'track-1'),
      reasoning('reasoning-between'),
      emptyAssistant('next-anchor'),
      call('in-flight-call', 'track-2'),
    ];

    const result = foldHistory(history, {
      estimateTokens: estimateByRenderedLength,
      minReductionRatio: 0.01,
      toMessageId: 'next-anchor',
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.foldedMessageIds).toEqual(['call-1', 'response-1']);
    expect(result.history.at(-2)).toBe(history[4]);
    expect(result.history.at(-1)).toBe(history[5]);
  });

  test('does not spend the prefix cache when the placeholder is not smaller enough', () => {
    const history = [
      assistant('anchor'),
      call('call', 'track', 1),
      response('response', 'track', 1),
    ];

    const result = foldHistory(history, {
      estimateTokens: estimateByRenderedLength,
      fromMessageId: 'call',
      minReductionRatio: 0.9,
      toMessageId: 'response',
    });

    expect(result.events).toEqual([]);
    expect(result.history).toEqual(history);
    for (const [index, message] of result.history.entries()) {
      expect(message).toBe(requireValue(history[index]));
    }
  });

  test('never folds across a user message that remains active', () => {
    const history = [
      assistant('anchor'),
      call('call', 'track', 4000),
      user('interleaved', 'do not move information across me'),
      response('response', 'track', 4000),
    ];

    const result = foldHistory(history, {
      estimateTokens: estimateByRenderedLength,
      fromMessageId: 'call',
      minReductionRatio: 0.01,
      toMessageId: 'response',
    });

    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.foldedMessageIds).toEqual(['call']);
    expect(result.events[1]?.foldedMessageIds).toEqual(['response']);
    expect(result.history.map((message) => message.messageId)).toEqual([
      'anchor',
      requireValue(result.events[0]).messageId,
      'interleaved',
      requireValue(result.events[1]).messageId,
    ]);
    expect(result.history[2]).toBe(history[2]);
  });

  test('a deferred result is a hard ordering boundary and is never folded', () => {
    const deferred = freezeMessage({
      createdAt: CREATED_AT,
      execution: 'deferredResult',
      messageId: 'deferred',
      name: 'tool',
      response: [{ text: 'later', type: 'text' }],
      role: 'toolResponse',
      trackId: 'track',
      trust: 'untrusted',
    });
    const history = [assistant('anchor'), call('call', 'track', 4000), deferred];

    const result = foldHistory(history, {
      estimateTokens: estimateByRenderedLength,
      fromMessageId: 'call',
      minReductionRatio: 0.01,
      toMessageId: 'deferred',
    });

    expect(result.events[0]?.foldedMessageIds).toEqual(['call']);
    expect(result.history.at(-1)).toBe(deferred);
  });

  test('tool traffic without a valid assistant anchor is left untouched instead of throwing', () => {
    const history = [user('request'), call('call', 'track'), response('response', 'track')];

    const result = foldHistory(history, {
      estimateTokens: estimateByRenderedLength,
      minReductionRatio: 0.01,
    });

    expect(result.events).toEqual([]);
    expect(result.history).toEqual(history);
  });

  test('rejects missing and reversed explicit ranges', () => {
    const history = [assistant('anchor'), call('call', 'track'), response('response', 'track')];
    expect(() =>
      foldHistory(history, { estimateTokens: estimateByRenderedLength, fromMessageId: 'missing' }),
    ).toThrow('missing message missing');
    expect(() =>
      foldHistory(history, {
        estimateTokens: estimateByRenderedLength,
        fromMessageId: 'response',
        toMessageId: 'call',
      }),
    ).toThrow('ends before it starts');
  });
});

describe('applyFold invariants', () => {
  const history = [assistant('anchor'), call('call', 'track'), response('response', 'track')];

  test('applies a valid event without recreating the anchor', () => {
    const event = foldEvent();
    const result = applyFold(history, event);
    expect(result).toEqual([requireValue(history[0]), event]);
    expect(result[0]).toBe(history[0]);
  });

  test('rejects empty, duplicate and self references', () => {
    expect(() => applyFold(history, foldEvent({ foldedMessageIds: [] }))).toThrow(
      'does not fold any messages',
    );
    expect(() => applyFold(history, foldEvent({ foldedMessageIds: ['call', 'call'] }))).toThrow(
      'duplicate message references',
    );
    expect(() => applyFold(history, foldEvent({ foldedMessageIds: ['fold'] }))).toThrow(
      'cannot fold itself',
    );
    expect(() => applyFold(history, foldEvent({ foldedMessageIds: ['anchor'] }))).toThrow(
      'cannot fold its own anchor',
    );
  });

  test('rejects missing, invalid and temporally impossible anchors', () => {
    expect(() => applyFold(history, foldEvent({ anchorMessageId: 'missing' }))).toThrow(
      'missing anchor',
    );
    expect(() =>
      applyFold(history, foldEvent({ anchorMessageId: 'call', foldedMessageIds: ['response'] })),
    ).toThrow('is not an assistant message');

    const lateAnchor = [call('call', 'track'), assistant('anchor')];
    expect(() => applyFold(lateAnchor, foldEvent({ foldedMessageIds: ['call'] }))).toThrow(
      'precedes its anchor',
    );
  });

  test('rejects references that are absent from the active projection', () => {
    expect(() => applyFold(history, foldEvent({ foldedMessageIds: ['call', 'missing'] }))).toThrow(
      'references missing messages: missing',
    );
  });
});
