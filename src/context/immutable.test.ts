import { describe, expect, test } from 'bun:test';

import { freezeMessage } from './immutable';

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected test value to exist.');
  return value;
}

const MUTATORS = [
  'setDate',
  'setFullYear',
  'setHours',
  'setMilliseconds',
  'setMinutes',
  'setMonth',
  'setSeconds',
  'setTime',
  'setUTCDate',
  'setUTCFullYear',
  'setUTCHours',
  'setUTCMilliseconds',
  'setUTCMinutes',
  'setUTCMonth',
  'setUTCSeconds',
  'setYear',
] as const;

describe('freezeMessage', () => {
  test('blocks every Date mutator, including legacy setYear', () => {
    const message = freezeMessage({
      content: [{ text: 'text', type: 'text' }],
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      messageId: 'message',
      role: 'user',
    });
    const original = message.createdAt.toISOString();

    for (const mutator of MUTATORS) {
      const mutate = (message.createdAt as unknown as Record<string, (value: number) => number>)[
        mutator
      ];
      expect(() => requireValue(mutate)(1)).toThrow(
        `Message timestamps are immutable: ${mutator}() is not available.`,
      );
      expect(message.createdAt.toISOString()).toBe(original);
    }
  });

  test('deep-copies and freezes tool arguments without mutating the input', () => {
    const argumentsValue = {
      array: [{ nested: 'value' }],
      date: new Date('2025-02-01T00:00:00.000Z'),
    };
    const message = freezeMessage({
      arguments: argumentsValue,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      messageId: 'call',
      name: 'tool',
      role: 'toolCall',
      trackId: 'track',
    });

    expect(message.arguments).not.toBe(argumentsValue);
    expect(Object.isFrozen(message.arguments)).toBeTrue();
    expect(Object.isFrozen(message.arguments.array)).toBeTrue();
    expect(Object.isFrozen(message.arguments.array[0])).toBeTrue();
    requireValue(argumentsValue.array[0]).nested = 'caller mutation';
    argumentsValue.date.setUTCFullYear(2030);
    expect(message.arguments.array[0]).toEqual({ nested: 'value' });
    expect(message.arguments.date.toISOString()).toBe('2025-02-01T00:00:00.000Z');
  });

  test('copies and freezes every mutable content layer', () => {
    const source = { data: 'abc', mediaType: 'image/png', type: 'base64' as const };
    const content = [
      { text: 'hello', type: 'text' as const },
      { source, type: 'image' as const },
    ];
    const message = freezeMessage({
      content,
      createdAt: new Date(),
      messageId: 'mixed',
      role: 'assistant',
    });

    expect(Object.isFrozen(message)).toBeTrue();
    expect(Object.isFrozen(message.content)).toBeTrue();
    expect(Object.isFrozen(message.content[0])).toBeTrue();
    expect(Object.isFrozen(message.content[1])).toBeTrue();
    expect(
      Object.isFrozen(message.content[1]?.type === 'image' && message.content[1].source),
    ).toBeTrue();
    source.data = 'changed';
    expect(message.content[1]?.type === 'image' && message.content[1].source).toEqual({
      data: 'abc',
      mediaType: 'image/png',
      type: 'base64',
    });
  });
});
