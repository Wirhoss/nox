import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { TEST_AUTHORITY } from '../../testFixtures';
import { freezeMessage } from './immutable';
import { resolveContextOptions } from './options';
import { estimateTokensByCharacters, TokenEstimator } from './tokens';

const CREATED_AT = new Date('2025-01-01T00:00:00.000Z');

function callWithArguments(argumentsValue: Record<string, unknown>) {
  return freezeMessage({
    arguments: argumentsValue,
    createdAt: CREATED_AT,
    messageId: 'call',
    name: 'tool',
    role: 'toolCall',
    trackId: 'track',
  });
}

describe('TokenEstimator', () => {
  test('is deterministic across object insertion order', () => {
    const first = callWithArguments({ alpha: 1, nested: { x: 1, y: 2 }, zebra: 2 });
    const second = callWithArguments({ zebra: 2, nested: { y: 2, x: 1 }, alpha: 1 });
    const estimator = new TokenEstimator('system', []);

    expect(estimator.estimateMessage(first)).toBe(estimator.estimateMessage(second));
  });

  test('caches immutable message estimates without recounting bytes', () => {
    let calls = 0;
    const estimator = new TokenEstimator('system', [], (text) => {
      calls++;
      return text.length;
    });
    const message = callWithArguments({ payload: 'value' });
    const before = calls;

    const first = estimator.estimateMessage(message);
    const afterFirst = calls;
    const second = estimator.estimateMessage(message);

    expect(first).toBe(second);
    expect(afterFirst).toBeGreaterThan(before);
    expect(calls).toBe(afterFirst);
  });

  test('accounts for artifact media by modality instead of its physical byte count', () => {
    const estimator = new TokenEstimator('system', [], (text) => text.length);
    const small = freezeMessage({
      content: [
        {
          artifact: {
            artifactId: 'art_small000',
            mediaType: 'image/png',
            size: 1,
          },
          type: 'artifact' as const,
        },
      ],
      createdAt: CREATED_AT,
      messageId: 'small',
      origin: {
        principal: { issuer: 'test', subject: 'alice' },
        transportMessageId: 'small',
      },
      role: 'user' as const,
    });
    const large = freezeMessage({
      ...small,
      content: [
        {
          artifact: {
            artifactId: 'art_large000',
            mediaType: 'image/png',
            size: 100_000_000,
          },
          type: 'artifact' as const,
        },
      ],
      messageId: 'large',
    });

    expect(
      Math.abs(estimator.estimateMessage(large) - estimator.estimateMessage(small)),
    ).toBeLessThan(30);
  });

  test('includes one stable system-and-tools prefix exactly once per history', () => {
    const schema = z.object({ value: z.string() });
    const tool = {
      authority: TEST_AUTHORITY,
      description: 'description',
      name: 'tool',
      parameters: schema,
      prepare: () => ({
        run: () => Promise.resolve([]),
        title: 'tool',
        type: 'immediate' as const,
      }),
    };
    const estimator = new TokenEstimator('system', [tool], (text) => text.length);
    const message = callWithArguments({});

    expect(estimator.prefixTokens).toBeGreaterThan(0);
    expect(estimator.estimateHistory([message])).toBe(
      estimator.prefixTokens + estimator.estimateMessage(message),
    );
  });

  test('rejects invalid custom counter output', () => {
    expect(() => new TokenEstimator('system', [], () => Number.NaN)).toThrow(
      'finite, non-negative',
    );
    expect(() => new TokenEstimator('system', [], () => -1)).toThrow('finite, non-negative');
  });

  test('the fallback estimator rounds up at three characters per token', () => {
    expect(estimateTokensByCharacters('')).toBe(0);
    expect(estimateTokensByCharacters('abc')).toBe(1);
    expect(estimateTokensByCharacters('abcd')).toBe(2);
  });
});

describe('context token policy', () => {
  test('derives pressure and adaptive token guards for small windows', () => {
    const options = resolveContextOptions({
      compactAtRatio: 0.5,
      contextWindow: 1000,
      reserveForOutput: 200,
    });

    expect(options.pressureTokenLimit).toBe(400);
    expect(options.compactGuardBeginningTokens).toBe(40);
    expect(options.compactGuardEndTokens).toBe(80);
    expect(options.compactMinTokens).toBe(40);
  });

  test('holds recalled memory outside the durable working-set budget', () => {
    const options = resolveContextOptions({
      compactAtRatio: 0.5,
      contextWindow: 1000,
      memoryReserveTokens: 100,
      reserveForOutput: 200,
    });

    expect(options.pressureTokenLimit).toBe(350);
  });

  test('explicit token policy values are preserved exactly, including zero guards', () => {
    const options = resolveContextOptions({
      compactGuardBeginningTokens: 0,
      compactGuardEndTokens: 0,
      compactMinTokens: 1,
    });
    expect(options.compactGuardBeginningTokens).toBe(0);
    expect(options.compactGuardEndTokens).toBe(0);
    expect(options.compactMinTokens).toBe(1);
  });

  test('rejects invalid and incomplete pressure policies', () => {
    expect(() => resolveContextOptions({ compactAtRatio: 0.5 })).toThrow(
      'contextWindow is required',
    );
    expect(() => resolveContextOptions({ contextWindow: 100, reserveForOutput: 100 })).toThrow(
      'reserveForOutput must be smaller',
    );
    expect(() => resolveContextOptions({ compactMinTokens: 0 })).toThrow();
    expect(() => resolveContextOptions({ compactGuardEndTokens: -1 })).toThrow();
  });

  test('sorts and freezes configured tools independent of insertion order', () => {
    const schema = z.object({});
    const base = {
      authority: TEST_AUTHORITY,
      description: 'tool',
      parameters: schema,
      prepare: () => ({
        run: () => Promise.resolve([]),
        title: 'tool',
        type: 'immediate' as const,
      }),
    };
    const options = resolveContextOptions({
      tools: {
        zebra: { ...base, name: 'zebra' },
        alpha: { ...base, name: 'alpha' },
      },
    });

    expect(Object.keys(options.tools)).toEqual(['alpha', 'zebra']);
    expect(Object.isFrozen(options.tools)).toBeTrue();
    expect(Object.isFrozen(options.tools.alpha)).toBeTrue();
    expect(Object.isFrozen(options.tools.zebra)).toBeTrue();
  });
});
