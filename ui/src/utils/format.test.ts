import { describe, expect, test } from 'bun:test';

import { formatDuration, formatFullTime, formatLogTime, formatTokens, shortId } from './format';

describe('shortId', () => {
  test('leaves ids of 12 characters or fewer untouched', () => {
    expect(shortId('run_12345678')).toBe('run_12345678');
    expect(shortId('short')).toBe('short');
    expect(shortId('')).toBe('');
  });

  test('caps longer ids at 12 characters', () => {
    expect(shortId('session_0123456789abcdef')).toHaveLength(12);
  });

  test('keeps the tail, so ids sharing a prefix stay distinguishable', () => {
    const first = shortId('session_aaaaaaaaaaaa001');
    const second = shortId('session_aaaaaaaaaaaa002');

    expect(first).not.toBe(second);
    expect(first).toBe('session_…001');
  });
});

describe('formatDuration', () => {
  test('scales to the unit that keeps the value readable', () => {
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(1500)).toBe('1.5 s');
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(90_000)).toBe('1m 30s');
  });

  test('distinguishes a run still in flight from one with no duration', () => {
    expect(formatDuration(null, 'running')).toBe('Running');
    expect(formatDuration(null, 'failed')).toBe('—');
    expect(formatDuration(null)).toBe('—');
  });
});

describe('formatTokens', () => {
  test('abbreviates only once the count needs it', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(42_000)).toBe('42k');
  });
});

describe('log timestamps', () => {
  test('render time of day with milliseconds', () => {
    expect(formatLogTime('2026-07-20T14:05:09.123Z')).toMatch(/\d{2}:\d{2}:\d{2}\.123/);
  });

  test('pass malformed values through rather than rewriting them', () => {
    expect(formatLogTime('not-a-date')).toBe('not-a-date');
    expect(formatFullTime('not-a-date')).toBe('not-a-date');
  });
});
