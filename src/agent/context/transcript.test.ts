import { describe, expect, test } from 'bun:test';

import { testOrigin } from '../../testFixtures';
import { messageToString } from './message';
import { Transcript } from './transcript';

import type { Logger } from '../../logger/logger';
import type { Message } from '@nox/extension-api';

const CREATED_AT = new Date('2025-01-01T00:00:00.000Z');

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected test value to exist.');
  return value;
}

function user(messageId: string, text: string): Message {
  return {
    content: [{ text, type: 'text' }],
    createdAt: CREATED_AT,
    messageId,
    origin: testOrigin(),
    role: 'user',
  };
}

function loggerWithWarnings(warnings: unknown[]): Logger {
  const record = (...args: unknown[]): void => {
    warnings.push(args);
  };
  const logger: Logger = {
    child: () => logger,
    debug: record,
    error: record,
    info: record,
    trace: record,
    warn: record,
  };
  return logger;
}

describe('Transcript', () => {
  test('is append-only and old snapshots remain immutable and bit-perfect', () => {
    const transcript = new Transcript([user('u1', 'first')]);
    const before = transcript.messages;
    const beforeBytes = before.map(messageToString);

    const appended = transcript.append(user('u2', 'second'));
    const after = transcript.messages;

    expect(Object.isFrozen(before)).toBeTrue();
    expect(before).toHaveLength(1);
    expect(before.map(messageToString)).toEqual(beforeBytes);
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(appended);
    expect(Object.isFrozen(appended)).toBeTrue();
  });

  test('skips duplicate persisted IDs with a warning but rejects duplicate live appends', () => {
    const warnings: unknown[] = [];
    const transcript = new Transcript([user('same', 'first'), user('same', 'duplicate')], {
      logger: loggerWithWarnings(warnings),
    });

    expect(transcript.messages).toHaveLength(1);
    expect(messageToString(requireValue(transcript.messages[0]))).toContain('first');
    expect(warnings).toHaveLength(1);
    expect(() => transcript.append(user('same', 'live duplicate'))).toThrow(
      'Duplicate message ID: same',
    );
  });

  test('records every role verbatim, including the ones no search will ever return', () => {
    const reasoning: Message = {
      content: [{ text: 'weighing whether to grep first', type: 'text' }],
      createdAt: CREATED_AT,
      messageId: 'think',
      role: 'reasoning',
    };
    const compacted: Message = {
      compactedMessageIds: ['think'],
      content: [{ text: 'a summary', type: 'text' }],
      createdAt: CREATED_AT,
      messageId: 'compact',
      role: 'compacted',
    };
    // Whether these are searchable is `isIndexable`'s question, asked at index
    // time. The transcript's own job is narrower and absolute: it keeps what it
    // was given, so a replay is bit-perfect no matter what the index skipped.
    const transcript = new Transcript([reasoning, compacted, user('u1', 'said out loud')]);

    expect(transcript.messages.map((message) => message.messageId)).toEqual([
      'think',
      'compact',
      'u1',
    ]);
  });

  test('reads tool results in stable bounded pages', () => {
    const transcript = new Transcript([
      {
        createdAt: CREATED_AT,
        execution: 'immediate',
        messageId: 'response',
        name: 'read',
        response: [{ text: '0123456789'.repeat(100), type: 'text' }],
        role: 'toolResponse',
        trackId: 'track',
        trust: 'untrusted',
      },
    ]);

    const first = transcript.readToolResult('track', 0, 250);
    expect(first[0]?.text.length).toBeGreaterThan(250);
    expect(first[0]?.text).toContain('Continue with offset 250');
    const second = transcript.readToolResult('track', 250, 250);
    expect(second[0]?.text).not.toBe(first[0]?.text);
    expect(() => transcript.readToolResult('missing', 0, 200)).toThrow('No tool response');
    expect(() => transcript.readToolResult('track', 100_000, 200)).toThrow(RangeError);
  });

  test('a deferred acknowledgement is not readable as the final result', () => {
    const transcript = new Transcript([
      {
        createdAt: CREATED_AT,
        execution: 'deferredAck',
        messageId: 'ack',
        name: 'work',
        response: [{ text: 'ack-only needle', type: 'text' }],
        role: 'toolResponse',
        trackId: 'track',
        trust: 'untrusted',
      },
    ]);

    expect(() => transcript.readToolResult('track', 0, 200)).toThrow('No tool response');
  });

  test('permission pending is not mistaken for the correlated final result', () => {
    const transcript = new Transcript([
      {
        createdAt: CREATED_AT,
        execution: 'permissionPending',
        messageId: 'pending',
        name: 'work',
        response: [{ text: 'waiting for approval', type: 'text' }],
        role: 'toolResponse',
        trackId: 'track',
        trust: 'untrusted',
      },
      {
        createdAt: new Date(CREATED_AT.getTime() + 1),
        execution: 'deferredResult',
        messageId: 'result',
        name: 'work',
        response: [{ text: 'finished', type: 'text' }],
        role: 'toolResponse',
        trackId: 'track',
        trust: 'untrusted',
      },
    ]);

    expect(transcript.readToolResult('track', 0, 200)[0]?.text).toContain('finished');
  });

  test('the append sink sees every live append, frozen, in order', () => {
    const seen: Message[] = [];
    const transcript = new Transcript([], {
      onAppend: (message) => seen.push(message),
    });

    transcript.append(user('first', 'one'));
    transcript.append(user('second', 'two'));

    expect(seen.map((message) => message.messageId)).toEqual(['first', 'second']);
    expect(Object.isFrozen(requireValue(seen[0]))).toBe(true);
  });

  test('the append sink is not called for messages the transcript was rebuilt from', () => {
    const seen: Message[] = [];
    const transcript = new Transcript([user('persisted', 'from storage')], {
      onAppend: (message) => seen.push(message),
    });

    expect(seen).toEqual([]);

    transcript.append(user('live', 'appended now'));
    expect(seen.map((message) => message.messageId)).toEqual(['live']);
  });

  test('a rejected duplicate append does not reach the sink', () => {
    const seen: Message[] = [];
    const transcript = new Transcript([user('taken', 'already here')], {
      onAppend: (message) => seen.push(message),
    });

    expect(() => transcript.append(user('taken', 'again'))).toThrow('Duplicate message ID');
    expect(seen).toEqual([]);
  });

  test('a throwing sink is logged and leaves the message recorded', () => {
    const logged: unknown[] = [];
    const transcript = new Transcript([], {
      logger: loggerWithWarnings(logged),
      onAppend: () => {
        throw new Error('storage is down');
      },
    });

    expect(() => transcript.append(user('kept', 'needle'))).not.toThrow();
    expect(transcript.messages.map((message) => message.messageId)).toEqual(['kept']);
    expect(logged).toHaveLength(1);
  });
});
